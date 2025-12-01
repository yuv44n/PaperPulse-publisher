const express = require('express');
const { runPublisher } = require('./publisher'); 
const app = express();
const PORT = process.env.PORT || 8080; 
app.use(express.json()); 
app.post('/', async (req, res) => {
  await runPublisher(req, res);
});
app.listen(PORT, () => {
  console.log(`[Publisher Service] Awaiting cron trigger at port ${PORT}`);
});