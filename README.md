# LawLens

Search US laws by keyword for your state and the federal government, read them in full with your place saved, and (optionally) use a free AI key to summarize a law or describe your situation and find the laws that apply.

> LawLens provides legal information, not legal advice. AI output can be wrong; always read the actual law and talk to a licensed attorney about your situation.

## Features

- **Pick your state** (all 50 + DC + PR) and search a keyword like `car ownership`, `inheritance` or `security deposit`. Everyday words are mapped to statutory terms (car → motor vehicle).
- **Results grouped by source**, all from official/free data:
  | Source | What | Key needed |
  |---|---|---|
  | [Open US Law](https://github.com/Vaquill-AI/open-us-law) | **Full text of state statutes and constitutions** (46 jurisdictions; not yet AR, CO, GA, MS, TN statutes) and the **US Code** — searched locally | none |
  | [eCFR](https://www.ecfr.gov/developers/documentation/api/v1) | Federal regulations (Code of Federal Regulations) | none |
  | [Federal Register](https://www.federalregister.gov/developers/documentation/api/v1) | Federal final rules | none |
  | [GovInfo](https://api.govinfo.gov/docs/) | Public Laws (Acts of Congress); US Code fallback until the local index is built | shared `DEMO_KEY` by default; free [api.data.gov key](https://api.data.gov/signup/) recommended |
  | [Open States](https://docs.openstates.org/api-v3/) | State bills and enacted session laws | free [Open States key](https://openstates.org/accounts/signup/) |
  | Official-source links | State code table of contents, Cornell LII state resources, a code-restricted search | none |

  The first time a state is searched, its statutes and constitution (7–61 MB) are downloaded from the Open US Law mirror and indexed with SQLite FTS5 in a worker thread; the page shows progress and fills in when done (≈20–40 s). The US Code (81 MB) is indexed at server start. Expect roughly 5–8× the download size on disk in `data/corpus.db` (about 700 MB for the US Code plus one large state).
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

## Licensing of the law text

Laws themselves are public domain (*Georgia v. Public.Resource.Org*, 2020). The compiled Open US Law dataset is published under **CC BY-NC 4.0** — free for personal, research, legal-aid and other non-commercial use with attribution (LawLens credits it on every section). Commercial use of that data needs a licence from Vaquill AI. Every section links to its official government publisher.

## Stack

Express + `node:sqlite` backend (`server/`), dependency-free vanilla JS front end (`public/`). Passwords are hashed with scrypt; sessions are HttpOnly cookies.
