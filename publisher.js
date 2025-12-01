const { createClient } = require('@supabase/supabase-js');
const parser = require('xml2js').parseStringPromise;
const fetch = require('node-fetch');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const MAX_RESULTS = 25; 
const ARXIV_URL = 'https://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate&sortOrder=descending&max_results=' + MAX_RESULTS;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
async function summarizeAndTag(text, apiKey) {
    if (!apiKey) {
        throw new Error("OPENROUTER_API_KEY is not set.");
    }
    const openRouterUrl = 'https://openrouter.ai/api/v1/chat/completions';
    const prompt = `Summarize the following research paper abstract in 65 words. Also extract up to 3 relevant keywords as tags. Return JSON with keys: summary, tags (as a list of strings).\n\n${text}`;
    const payload = {
        "model": "x-ai/grok-4.1-fast:free",
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
        },
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        const errorData = await response.json();
        console.error('OpenRouter API Error:', errorData);
        throw new Error(`External API failure: Status ${response.status}`);
    }
    const data = await response.json();
    const content = data.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        const jsonMap = JSON.parse(jsonMatch[0]);
        return {
            summary: jsonMap.summary || '',
            tags: (jsonMap.tags || []).map(t => t.toString()),
        };
    } else {
        throw new Error('Failed to parse valid JSON response from AI.');
    }
}
exports.runPublisher = async (req, res) => {
    const expectedSecret = CRON_SECRET;
    const headers = req?.headers || {};
    const incomingSecret = headers['x-cron-secret']; 
    if (expectedSecret && incomingSecret !== expectedSecret) {
        console.warn('Unauthorized access attempt to publisher job. Returning 403.');
        return res.status(403).send('Forbidden: Invalid cron secret.');
    }
    console.log('--- Starting Scheduled Supabase Publisher ---');
    try {
        const xmlResponse = await fetch(ARXIV_URL);
        const xmlText = await xmlResponse.text();
        const result = await parser(xmlText, { explicitArray: false });
        const entries = result.feed.entry || [];
        let newPapersCount = 0;
        let skippedCount = 0;
        for (const entry of entries) {
            const arxiv_id = entry.id.replace('http://arxiv.org/abs/', '').replace('https://arxiv.org/abs/', '');
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
                console.log(`[Skip] Paper ${arxiv_id} already exists in DB. Skipping AI call.`);
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
                    .upsert([paperData], { 
                        onConflict: 'arxiv_id', 
                    })
                    .select('arxiv_id');
                if (error) {
                    console.error(`Error writing paper ${arxiv_id}:`, error.message);
                } else if (status === 201) { 
                    newPapersCount++;
                    console.log(`Published NEW paper: ${arxiv_id}`);
                } else if (status === 200) {
                    console.warn(`Paper ${arxiv_id} updated unexpectedly after existence check.`);
                    skippedCount++;
                } else {
                    console.log(`Paper ${arxiv_id} handled with unexpected status ${status}.`);
                }
            } catch (processingError) {
                console.error(`Skipping paper ${arxiv_id} due to AI processing error:`, processingError.message);
            }
        }
        console.log(`--- Publishing finished. Total papers processed: ${entries.length}. New papers: ${newPapersCount}, Skipped: ${skippedCount} ---`);
        return res.status(200).send(`Publisher ran successfully. New papers: ${newPapersCount}, Skipped: ${skippedCount}`);
    } catch (error) {
        console.error('Critical Publisher Error:', error);
        return res.status(500).send(`Publisher failed: ${error.message}`);
    }
};