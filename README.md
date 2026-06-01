# grade-brain

An iMessage grade calculator bot that tracks your classes, logs grades, applies curves, and tells you exactly what you need to hit your target grade.

Built with **Sendblue** (iMessage API), **Anthropic Claude** (AI parsing), Node.js, and Express.

---

## Canvas integration (optional)

On first launch, grade-brain texts you asking if you want to connect Canvas. If you say yes, it walks you through getting a personal access token and automatically imports all your active courses — categories, weights, and grades — with no syllabus pasting required.

Once connected, text **"sync canvas"** any time to pull the latest scores. Canvas scores and manually entered grades are stored separately, so syncing Canvas never overwrites grades you typed in yourself.

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
| `bio is 3 credits` | Sets credit hours for a class |
| `my GPA` | Shows semester GPA weighted by credit hours |
| `update syllabus for bio` | Update weights mid-semester without losing grades |
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
   Grading: Homework assignments 20% (drop lowest), Two midterm exams 40% total, Final exam 30%,
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
   3 – Norm-referenced / median mapped to a letter grade
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
Raw: 87.4% B+
Curved: 91.2% A- — +3.8 pts (scale to mean 75)
(70% of grade entered)

Midterm Exams (40%): 85%
Homework (20%): 92.3% (avg of 4, 1 lowest dropped)
Participation (10%): 95%

To earn:
A: need 97 on remaining 30%
A-: need 90 on remaining 30%
B+: need 81 on remaining 30%
```

---

## Curve types

| Type | How it works |
|---|---|
| **Flat** | Adds a fixed number of points to every score (e.g. +5), caps at 100 |
| **Scale to mean** | Shifts your grade by (targetAverage − classAverage) when you enter the class average, caps at 100, never pulls scores down |
| **Norm-referenced** | You enter the class median and what letter grade the professor maps it to. Uses relative positioning to assign a letter grade above or below the median |
| **None** | No curve applied |

For mean-based curves: if the class average comes in higher than the target, no shift is applied and the bot explains why.

For norm-referenced curves: grade projection ("what do I need for an A?") is unavailable since the final letter depends on where the class median lands.

---

## Drop-lowest

If your syllabus says "drop the lowest homework", Claude detects it automatically during setup and stores it on that category. The lowest score is excluded from the average once you have more grades than the drop count — e.g. if you drop 1 and only have 1 homework entered, all grades still count. The breakdown shows `(1 lowest dropped)` when a drop is active.

---

## Semester GPA

Set credit hours per class and grade-brain calculates your weighted semester GPA:

```
you: bio is 3 credits
you: data structures is 4 credits
you: my GPA

Bot: Semester GPA: 3.52

• Bio 101: A- (3 cr)
• Data Structures: B+ (4 cr)
```

If any class is missing credit hours, the bot lists them and tells you how to set them.

---

## Data storage

All data is saved to `classes.json` in the project folder. You can edit it directly if needed. Canvas grades and manually entered grades are stored in separate fields (`canvasGrades` and `grades`) so a Canvas sync never clobbers manual entries.

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
├── grades.js      — Grade math: weighted averages, curves, projections, GPA
├── classes.json   — Auto-created when you add your first class
├── .env           — Your API keys (never commit this)
└── .env.example   — Template for .env
```

---

## Limitations

- **Photos**: Syllabus photos and PDFs are supported. If parsing fails, try pasting the grading section as text.
- **Multiple grades per category**: The bot averages them. Use the drop-lowest feature if your syllabus supports it; otherwise enter the average manually.
- **Norm-referenced curves**: Grade projection is not available — the final letter depends on the class median, which isn't known until grades are posted.
- **Always-on**: The bot only works while your local server (and ngrok tunnel) are running. For a permanent setup, deploy to Railway, Render, or Fly.io.
- **Single user**: The bot only responds to the phone number set in `MY_PHONE`.
