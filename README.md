# LawLens

Search US laws by keyword for your state and the federal government, read them in full with your place saved, and use the built-in AI Analyst to summarize a law or describe your situation and find the laws that apply. Visitors never need an API key: the site owner's keys (in `.env`) power everything.

> LawLens provides legal information, not legal advice. AI output can be wrong; always read the actual law and talk to a licensed attorney about your situation.

## Features

- **Pick your state** (all 50 + DC + PR) and search a keyword like `car ownership`, `inheritance` or `security deposit`. Everyday words are mapped to statutory terms (car → motor vehicle).
- **Results grouped by source**, all from official/free data:
  | Source | What | Server key (`.env`) |
  |---|---|---|
  | [Open US Law](https://github.com/Vaquill-AI/open-us-law) | **Full text of state statutes and constitutions** (46 jurisdictions; not yet AR, CO, GA, MS, TN statutes) and the **US Code** — searched locally | none |
  | [eCFR](https://www.ecfr.gov/developers/documentation/api/v1) | Federal regulations (Code of Federal Regulations) | none |
  | [Federal Register](https://www.federalregister.gov/developers/documentation/api/v1) | Federal final rules | none |
  | [GovInfo](https://api.govinfo.gov/docs/) | Public Laws (Acts of Congress); US Code fallback until the local index is built | optional `GOVINFO_API_KEY` ([free](https://api.data.gov/signup/)); shared `DEMO_KEY` otherwise |
  | [Open States](https://docs.openstates.org/api-v3/) | State bills and enacted session laws | `OPENSTATES_API_KEY` ([free](https://openstates.org/accounts/signup/)); this source is hidden without it |
  | Official-source links | State code table of contents, Cornell LII state resources, a code-restricted search | none |

  The first time a state is searched, its statutes and constitution (7–61 MB) are downloaded from the Open US Law mirror and indexed with SQLite FTS5 in a worker thread; the page shows progress and fills in when done (≈20–40 s). The US Code (81 MB) is indexed at server start. Expect roughly 5–8× the download size on disk in `data/corpus.db` (about 700 MB for the US Code plus one large state).
- **Search by citation or section number** — `Cal. PEN § 1170(h)`, `Penal Code 1170 subdivision (h)`, `PC 187`, `B&P 17200`, `Code of Civil Procedure 116.220`, `Tex. Fam. Code 6.001`, `765 ILCS 710/1`, `42 USC 1983`, `41 CFR 102-34.305`, or just `1170` (every code's § 1170 in your state). A subdivision opens the section scrolled to and highlighting that subdivision.
- **Clickable cross-references** — in statute text, “subdivision (h) of Section 1170”, “Section 1203.4 of the Penal Code” or “Section 6.001, Family Code” link straight to the referenced section (only when it exists in the index).
- **Reader** shows the full text in-app. Scroll position is saved by paragraph, so **Continue reading** reopens exactly where you stopped.
- **Accounts** (email + password) sync reading history and settings across devices. Guests keep history in the browser; it is merged into the account on sign-up.
- **Analyst (AI)**: runs on the site owner's free Gemini, Groq or OpenRouter key. Users only switch it on or off in Settings:
  - *Summarize* any law, or chat with it ("does this apply if the car was a gift?").
  - *Analyst tab*: describe your situation ("my friend says I haven't inherited this money, I think I did") and get relevant state + federal citations explained, plus one-click searches of the official databases.
  - To protect the shared free quota, AI requires sign-in by default (`AI_REQUIRE_ACCOUNT`) and each user (or IP) is capped per hour (`AI_REQUESTS_PER_HOUR`, default 30). Failed calls don't count, and provider errors are logged on the server rather than shown to users.

## Run it

Requires Node.js 22.13+ (uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env   # then set AI_API_KEY (and optionally OPENSTATES_API_KEY / GOVINFO_API_KEY)
npm start              # http://localhost:3000
```

Accounts, sessions and reading history are stored in `data/lawlens.db` (SQLite) and the law index in `data/corpus.db`, both on the machine running the server and never in git. When deploying, put `data/` on a persistent disk. Set `DB_PATH` or `PORT` to change locations.

### AI setup

1. Get a free key, e.g. [Google AI Studio](https://aistudio.google.com/apikey) (Gemini), [Groq](https://console.groq.com/keys) or [OpenRouter](https://openrouter.ai/keys).
2. In `.env` set `AI_PROVIDER=gemini` (or `groq` / `openrouter`) and `AI_API_KEY=…`. `AI_MODEL` is optional.
3. Restart the server. The Settings page shows "Provided free by this site" when AI is active.

## Licensing of the law text

Laws themselves are public domain (*Georgia v. Public.Resource.Org*, 2020). The compiled Open US Law dataset is published under **CC BY-NC 4.0** — free for personal, research, legal-aid and other non-commercial use with attribution (LawLens credits it on every section). Commercial use of that data needs a licence from Vaquill AI. Every section links to its official government publisher.

## Stack

Express + `node:sqlite` backend (`server/`), dependency-free vanilla JS front end (`public/`). Passwords are hashed with scrypt; sessions are HttpOnly cookies.
