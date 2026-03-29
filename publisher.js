/**
 * PaperPulse Supabase Publisher (Node.js Serverless Function)
 * * This script runs periodically (e.g., via a Cron Job) to:
 * 1. Fetch the latest papers from the ArXiv API (using HTTPS).
 * 2. Call the AI model (OpenRouter) to generate a summary and tags for each paper.
 * 3. Write the processed data to the Supabase 'papers' table using 'upsert'.
 * 4. ALERTS: Uses Discord Webhook for error notifications.
 */

const { createClient } = require('@supabase/supabase-js');
const parser = require('xml2js').parseStringPromise;
const fetch = require('node-fetch');

// Environment Variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const MAX_RESULTS = 50; 
const ARXIV_URL = 'https://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate&sortOrder=descending&max_results=' + MAX_RESULTS;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* Helper to send alerts to Discord*/
async function sendDiscordAlert(message) {
    if (!DISCORD_WEBHOOK_URL) return;
    try {
        await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: `🚨 **PaperPulse Publisher Error**\n${message}`
            })
        });
    } catch (err) {
        console.error("Failed to send Discord alert:", err);
    }
}


async function summarizeAndTag(text, apiKey) {
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set.");

    const openRouterUrl = 'https://openrouter.ai/api/v1/chat/completions';
    const prompt = `Summarize the following research paper abstract in 65 words. Also extract up to 3 relevant keywords as tags. Return your response as valid JSON in the following format (replace the example values with your output):\n\n{\n  \"summary\": \"<summary text>\",\n  \"tags\": [\"tag1\", \"tag2\", \"tag3\"]\n}\n\nAbstract:\n${text}`;

    const payload = {
        "model": OPENROUTER_MODEL,
        "messages": [
            {"role": "user", "content": prompt}
        ],
        "max_tokens": 512,
        "temperature": 0.5
    };

    const response = await fetch(openRouterUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://paperpulse.app', 
            'X-Title': 'PaperPulse'
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errorData = await response.json();
        const errorMessage = `OpenRouter API (${OPENROUTER_MODEL}) Failed: ${response.status} - ${JSON.stringify(errorData)}`;
        console.error(errorMessage);
        
        // ALERT: Send notification immediately on API failure
        await sendDiscordAlert(errorMessage);
        
        throw new Error(`External API failure: Status ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content;
    if (!content) {
        console.warn('Skipping: content is null or undefined');
        return null;
    }
    console.log('AI raw output:', content);
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        console.warn('AI output did not contain valid JSON. Raw output:', content);
        return null;
    }
    let jsonMap = null;
    try {
        jsonMap = JSON.parse(jsonMatch[0]);
    } catch (e) {
        console.warn('Failed to parse JSON from AI output. Raw output:', content);
        return null;
    }
    if (!jsonMap || typeof jsonMap !== 'object') {
        console.warn('Parsed JSON is null or not an object. Raw output:', content);
        return null;
    }
    return {
        summary: jsonMap.summary || '',
        tags: Array.isArray(jsonMap.tags) ? jsonMap.tags.map(t => t.toString()) : [],
    };
}


exports.runPublisher = async (req, res) => {
    const expectedSecret = CRON_SECRET;
    const headers = req?.headers || {};
    const incomingSecret = headers['x-cron-secret']; 
    
    if (expectedSecret && incomingSecret !== expectedSecret) {
        console.warn('Unauthorized access attempt to publisher job.');
        return res.status(403).send('Forbidden: Invalid cron secret.');
    }

    console.log(`--- Starting Publisher using model: ${OPENROUTER_MODEL} ---`);
    
    try {
        const xmlResponse = await fetch(ARXIV_URL);
        
        // FIX: Check for HTTP errors from ArXiv before parsing
        if (!xmlResponse.ok) {
            throw new Error(`ArXiv API returned status: ${xmlResponse.status} ${xmlResponse.statusText}`);
        }

        const xmlText = await xmlResponse.text();

        // FIX: Validate XML content before parsing
        if (xmlText.trim().startsWith('Rate limit') || !xmlText.trim().startsWith('<')) {
             throw new Error(`ArXiv API returned invalid XML (Likely Rate Limit): "${xmlText.substring(0, 100)}..."`);
        }

        const result = await parser(xmlText, { explicitArray: false });
        
        const entries = result.feed?.entry || [];
        const entriesArray = Array.isArray(entries) ? entries : [entries];

        let newPapersCount = 0;
        let skippedCount = 0;
        
        for (const entry of entriesArray) {
            if (!entry || !entry.id) continue;

            const arxiv_id = entry.id.replace(/https?:\/\/arxiv\.org\/abs\//, '');
            
            if (!entry.summary || !entry.title) continue; 

            const { count, error: countError } = await supabase
                .from('papers')
                .select('arxiv_id', { count: 'exact' })
                .eq('arxiv_id', arxiv_id);

            if (countError) {
                console.error(`Database error checking paper ${arxiv_id}:`, countError.message);
                continue;
            }

            if (count > 0) {
                skippedCount++;
                console.log(`[Skip] Paper ${arxiv_id} already exists.`);
                continue; 
            }
            
            try {
                const abstract = entry.summary._ || entry.summary;
                const aiResult = await summarizeAndTag(abstract, OPENROUTER_API_KEY); 

                const paperData = {
                    arxiv_id: arxiv_id, 
                    title: entry.title,
                    authors: Array.isArray(entry.author) 
                             ? entry.author.map(a => a.name) 
                             : (entry.author ? [entry.author.name] : []),
                    keywords: aiResult.tags,
                    summary: aiResult.summary,
                    link: entry.id,
                    published_at: new Date().toISOString()
                };

                const { error, status } = await supabase
                    .from('papers')
                    .upsert([paperData], { onConflict: 'arxiv_id' })
                    .select('arxiv_id');

                if (error) {
                    console.error(`Error writing paper ${arxiv_id}:`, error.message);
                } else if (status === 201) { 
                    newPapersCount++;
                    console.log(`Published NEW paper: ${arxiv_id}`);
                } else {
                    skippedCount++;
                }
            } catch (processingError) {
                console.error(`Skipping paper ${arxiv_id}:`, processingError.message);
            }
        }

        const summaryMsg = `--- Finished. Processed: ${entriesArray.length}. New: ${newPapersCount}. Skipped: ${skippedCount}. Model: ${OPENROUTER_MODEL} ---`;
        console.log(summaryMsg);
        return res.status(200).send(summaryMsg);

    } catch (error) {
        console.error('Critical Publisher Error:', error);
        await sendDiscordAlert(`Critical Script Failure: ${error.message}`);
        return res.status(500).send(`Publisher failed: ${error.message}`);
    }
};