# LawLens

Search US laws by keyword for your state and the federal government, read them in full with your place saved, and (optionally) use a free AI key to summarize a law or describe your situation and find the laws that apply.

> LawLens provides legal information, not legal advice. AI output can be wrong; always read the actual law and talk to a licensed attorney about your situation.

## Features

- **Pick your state** (all 50 + DC + PR) and search a keyword like `car ownership`, `inheritance` or `security deposit`. Everyday words are mapped to statutory terms (car → motor vehicle).
- **Results grouped by source**, all from official/free data:
  | Source | What | Key needed |
  |---|---|---|
  | [eCFR](https://www.ecfr.gov/developers/documentation/api/v1) | Federal regulations (Code of Federal Regulations) | none |
  | [Federal Register](https://www.federalregister.gov/developers/documentation/api/v1) | Federal final rules | none |
  | [GovInfo](https://api.govinfo.gov/docs/) | United States Code sections + Public Laws (Acts of Congress) | shared `DEMO_KEY` by default; free [api.data.gov key](https://api.data.gov/signup/) recommended |
  | [Open States](https://docs.openstates.org/api-v3/) | State bills and enacted session laws | free [Open States key](https://openstates.org/accounts/signup/) |
  | Official-source links | State code table of contents, Cornell LII state resources, a code-restricted search | none |
- **Reader** shows the full text in-app. Scroll position is saved by paragraph, so **Continue reading** reopens exactly where you stopped.
- **Accounts** (email + password) sync reading history and settings across devices. Guests keep history in the browser; it is merged into the account on sign-up.
- **Analyst (AI, opt-in in Settings)** — bring a free key from Google Gemini, Groq or OpenRouter:
  - *Summarize* any law, or chat with it ("does this apply if the car was a gift?").
  - *Analyst tab*: describe your situation ("my friend says I haven't inherited this money, I think I did") and get relevant state + federal citations explained, plus one-click searches of the official databases.
  - Keys stay in your browser's localStorage and are forwarded per request — never stored on the server.

## Run it

Requires Node.js 22.13+ (uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env   # optional: server-wide OPENSTATES_API_KEY / GOVINFO_API_KEY
npm start              # http://localhost:3000
```

Data is stored in `data/lawlens.db` (SQLite). Set `DB_PATH` or `PORT` to change.

## Why some state statutes open externally

There is no free, official, all-states API for state *codes*, and the commercial sites that host them block automated access. LawLens therefore reads state **legislation** in-app via Open States and links out to the published state code for statutes. The Analyst can name exact state code sections for your question.

## Stack

Express + `node:sqlite` backend (`server/`), dependency-free vanilla JS front end (`public/`). Passwords are hashed with scrypt; sessions are HttpOnly cookies.
