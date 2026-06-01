# grade-brain

An iMessage grade calculator bot that tracks your classes, logs grades, applies curves, and tells you exactly what you need to hit your target grade.

Built with **Sendblue** (iMessage API), **Anthropic Claude** (AI parsing), Node.js, and Express.

---

## Canvas integration (optional)

On first launch, grade-brain texts you asking if you want to connect Canvas. If you say yes, it walks you through getting a personal access token and automatically imports all your active courses — categories, weights, and grades — with no syllabus pasting required.

Once connected, text **"sync canvas"** any time to pull the latest grades.

> **Canvas limitation:** Canvas does not expose class averages to the API. If your professor curves grades based on the class average, you still need to enter those manually (e.g. "class average was 71 on bio midterm"). The curve calculation logic then works exactly the same regardless of how the class was set up.

---

## What it does

Text your Sendblue number and grade-brain handles the rest:

| Text | What happens |
|---|---|
| `new class: Bio 101` | Starts class setup — paste your syllabus grading section |
| `got 85 on bio midterm` | Logs your grade |
| `class average was 71 on bio midterm` | Logs the class average (used for curve calculations) |
| `what's my grade in bio?` | Shows current grade, per-category breakdown, and what you need on remaining assignments |
| `show all my grades` | One-line summary of every class |
| `delete bio` | Removes a class |
| `sync canvas` | Pull latest grades from Canvas |
| `connect canvas` | (Re)link your Canvas account |
| `help` | Shows command list |

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Fill in:
- **SENDBLUE_API_KEY** / **SENDBLUE_API_SECRET** — from your [Sendblue dashboard](https://sendblue.co)
- **SENDBLUE_NUMBER** — the Sendblue number you registered (E.164 format: `+1xxxxxxxxxx`)
- **MY_PHONE** — your personal phone number (only this number can use the bot)
- **ANTHROPIC_API_KEY** — from [console.anthropic.com](https://console.anthropic.com)

### 3. Expose your local server with ngrok

Sendblue needs a public HTTPS URL to send webhooks to. Use [ngrok](https://ngrok.com) to create a tunnel:

```bash
# In a separate terminal:
ngrok http 3000
```

Copy the `https://xxxx.ngrok-free.app` URL.

### 4. Set the webhook URL in Sendblue

Go to your Sendblue dashboard → **Webhooks** → set the incoming message URL to:

```
https://xxxx.ngrok-free.app/webhook
```

### 5. Start the bot

```bash
npm start
# or for auto-restart during development:
npm run dev
```

You should see:
```
grade-brain listening on port 3000
```

### 6. Text it!

Send `new class: Bio 101` to your Sendblue number from your phone.

---

## Adding a class (walkthrough)

1. **You:** `new class: Bio 101`
2. **Bot:** `Starting Bio 101! Paste the grading breakdown from your syllabus.`
3. **You:** *(paste messy syllabus text)*
   ```
   Grading: Homework assignments 20%, Two midterm exams 40% total, Final exam 30%,
   Participation and attendance 10%
   ```
4. **Bot:**
   ```
   Here's what I found for Bio 101:
   • Homework: 20%
   • Midterm Exams: 40%
   • Final Exam: 30%
   • Participation: 10%

   Does it have a curve?
   1 – Flat points added to all scores
   2 – Scale to class mean
   3 – Bell curve / distribution
   4 – No curve
   ```
5. **You:** `2`
6. **Bot:** `What does the professor want the class average to be?`
7. **You:** `75`
8. **Bot:** `Curve saved — class average will be scaled to 75. Bio 101 is all set!`

---

## Grade check example

After entering some grades:

```
Bio 101
Current: 88.2% B+
(70% of grade entered)

Midterm Exams (40%): 85 → 89 curved
Homework (20%): 92.3 (avg of 4)
Participation (10%): 95

To earn:
A: need 100 on remaining 30%
A-: need 93 on remaining 30%
B+: need 84 on remaining 30%
B: need 74 on remaining 30%
```

---

## Curve types

| Type | How it works |
|---|---|
| **Flat** | Adds a fixed number of points to every score (e.g. +5) |
| **Scale to mean** | When you enter the class average, the bot adds the difference between the target mean and actual mean to your score |
| **Distribution** | Estimates your letter grade using a z-score against the class average — shown as an estimate only |
| **None** | No curve applied |

For mean-based curves: if you said the target mean is 75 and the class average on the midterm was 71, the bot adds +4 to your midterm score automatically.

---

## Data storage

All data is saved to `classes.json` in the project folder. You can edit it directly if needed. The structure looks like:

```json
{
  "classes": {
    "bio 101": {
      "name": "Bio 101",
      "categories": [
        { "name": "Midterm Exams", "weight": 40 },
        { "name": "Final Exam", "weight": 30 },
        { "name": "Homework", "weight": 20 },
        { "name": "Participation", "weight": 10 }
      ],
      "grades": {
        "midterm exams": [85],
        "homework": [90, 88, 95, 96],
        "participation": [95]
      },
      "classAverages": {
        "midterm exams": 71
      },
      "curve": {
        "type": "mean",
        "targetMean": 75
      }
    }
  },
  "userStates": {
    "+12025551234": { "step": "idle", "pendingClass": null }
  }
}
```

---

## Project structure

```
grade-brain/
├── index.js       — Express server + Sendblue webhook receiver
├── bot.js         — Conversation logic, state machine, message routing
├── claude.js      — Anthropic API calls (syllabus parsing, intent classification)
├── canvas.js      — Canvas LMS API: fetch courses, assignment groups, grades
├── sendblue.js    — Sendblue API wrapper (send iMessages)
├── storage.js     — Read/write classes.json + write Canvas creds to .env
├── grades.js      — Grade math: weighted averages, curves, projections
├── classes.json   — Auto-created when you add your first class
├── .env           — Your API keys (never commit this)
└── .env.example   — Template for .env
```

---

## Limitations

- **Photos**: If you text a photo of your syllabus, the bot will ask you to paste the text instead. (Claude can read text, not images, via this integration.)
- **Multiple grades per category**: If you have multiple exams in one category, the bot averages them. To drop the lowest, enter the average manually.
- **Distribution curves**: The letter grade estimate is a rough approximation. Real bell curves vary by professor.
- **Always-on**: The bot only works while your local server (and ngrok tunnel) are running. For a permanent setup, deploy to Railway, Render, or Fly.io.
