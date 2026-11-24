# Deploy to free cloud hosting (Render + Neon) — keeps the site online 24/7

## 1. GitHub
1. Go to https://github.com → Sign up / Sign in
2. Click **+ → New repository** → name it `homework-tracker` → **Create repository**
3. Install Git if you don't have it: https://git-scm.com/downloads
4. Open a terminal in this folder and run:
   ```
   git init
   git add .
   git commit -m "Homework tracker"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/homework-tracker.git
   git push -u origin main
   ```

## 2. Neon (free Postgres database)
1. Go to https://neon.tech → **Sign up** (GitHub login works)
2. Click **New Project** → name `homework` → **Create Project**
3. Copy the **Connection string** (starts with `postgres://...`)

## 3. Render (free hosting)
1. Go to https://render.com → **Sign up** (GitHub login works)
2. **New + → Web Service** → connect your `homework-tracker` repo
   - Environment: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
3. Under **Environment**, add:
   - Key: `DATABASE_URL`  Value: (the Neon connection string from step 2)
4. Click **Create Web Service**

Done! Your site gets a permanent URL like `https://homework-tracker-xxxx.onrender.com`.

## 4. Optional: connect a real AI model
The 🤖 assistant works out of the box with a built-in offline helper (no key needed).
To use a real LLM instead, add these Render environment variables:

| Key | Value | Example |
| --- | --- | --- |
| `AI_API_KEY` | API key from your provider | `sk-...` |
| `AI_BASE_URL` | OpenAI-compatible endpoint (optional) | `https://api.openai.com/v1` |
| `AI_MODEL` | Model name (optional) | `gpt-4o-mini` |

`OPENAI_API_KEY` and `OPENROUTER_API_KEY` also work as the key variable.
If the request fails or no key is set, the assistant automatically falls back to the built-in helper.

## New features
- 🤖 AI assistant: what's left, overdue, tomorrow, study tips, motivation and a 7-day plan
- 📅 Homework calendar with priority dots
- 🏆 Class rating (completed counts only — private tasks stay private)
- 📊 Progress bars per subject
- 📝 Notes, priority levels, duplicate, multi-select delete and print view
- ⏱ Pomodoro focus timer and a quick light/dark switch

## Notes
- The FIRST account registered on the new site becomes the **🛠 CREATOR** (that's you).
- Your old data from this laptop isn't transferred automatically — re-register and re-add homework, or ask me and I'll write a data-import tool.
- Render free services "sleep" after 15 min of no visits, but wake up instantly (a few seconds) when someone opens the link — so friends can always access it, even with your laptop off.
