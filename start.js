require('dotenv').config();

const publisherModule = require('./publisher');

const mockReq = { 
    headers: {
        
    }
};

const mockRes = {
    status: (code) => {
        console.log(`\n[Local Runner] HTTP Status: ${code}`);
        return { 
            send: (msg) => console.log(`[Local Runner] Response Body: ${msg}`),
            json: (data) => console.log(`[Local Runner] Response JSON:`, data)
        };
    },
    send: (msg) => console.log(`[Local Runner] Response Body: ${msg}`),
    json: (data) => console.log(`[Local Runner] Response JSON:`, data)
};

async function executeLocalRun() {
    console.log("==========================================");
    console.log("       Starting PaperPulse Publisher      ");
    console.log("==========================================");
    console.log(`Checking ENV: URL: ${process.env.SUPABASE_URL ? 'Loaded' : 'MISSING'}`);
    
    if (!publisherModule.runPublisher) {
        console.error("\n--- RUN FAILED ---");
        console.error("Error: Could not find 'runPublisher' export in publisher.js. Check the file's export syntax.");
        return;
    }

    try {
        await publisherModule.runPublisher(mockReq, mockRes);
        console.log("\nLOCAL RUN COMPLETE. Check your Supabase database.");
    } catch (error) {
        console.error("\n--- LOCAL RUN FAILED ---");
        console.error("Error:", error);
    }
}

executeLocalRun();