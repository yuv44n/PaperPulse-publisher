# PaperPulse: Research Discovery, Simplified

![PaperPulse Banner](https://raw.githubusercontent.com/yuv44n/PaperPulse/main/banner.png)
### PaperPulse is the best way to catch up on recent advancements in AI/ML.

## Go to main repository: **[github.com/yuv44n/PaperPulse](https://github.com/yuv44n/PaperPulse)**

### Role: Runs a scheduled job every 30 minutes to fetch new arXiv papers, summarize them using AI, and save them to Supabase.

## Steps to Deploy Your Own Backend:

- Clone the Publisher Repo: Clone the repository linked above.

- Set up Supabase: Create a new project and get your SUPABASE_URL and SERVICE_ROLE_KEY.
  
- Deploy to Railway: Connect the repo to Railway.

- Configure Variables: Add OPENROUTER_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and CRON_SECRET in Railway.

- Configure Alerts (Recommended): Add a DISCORD_WEBHOOK_URL variable in Railway to receive instant notifications if the publisher fails.

- Set up Scheduler: Use GitHub Actions (included in the repo) to trigger the Railway service every 30 minutes.
