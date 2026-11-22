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

  Each jurisdiction has its own SQLite FTS5 search index. A GitHub Actions workflow (`.github/workflows/build-index.yml`) builds them from the Open US Law snapshot and publishes them as the [`index` release](../../releases/tag/index), so the server only downloads a ready-made file: the US Code and California at startup, any other state the first time it's searched (a few seconds to a minute; the page shows progress). If no prebuilt index is available, the server indexes the parquet files itself in a worker thread instead.
- **Search by citation or section number** — `Cal. PEN § 1170(h)`, `Penal Code 1170 subdivision (h)`, `PC 187`, `B&P 17200`, `Code of Civil Procedure 116.220`, `Tex. Fam. Code 6.001`, `765 ILCS 710/1`, `42 USC 1983`, `41 CFR 102-34.305`, or just `1170` (every code's § 1170 in your state). A subdivision opens the section scrolled to and highlighting that subdivision.
- **Clickable cross-references** — in statute text, “subdivision (h) of Section 1170”, “Section 1203.4 of the Penal Code” or “Section 6.001, Family Code” link straight to the referenced section (only when it exists in the index).
- **Reader** shows the full text in-app. Scroll position is saved by paragraph, so **Continue reading** reopens exactly where you stopped.
- **Accounts** (email + password) sync reading history and settings across devices. Guests keep history in the browser; it is merged into the account on sign-up.
- **Analyst (AI)**: runs on the site owner's free Gemini, Groq or OpenRouter key. Users only switch it on or off in Settings:
  - *Summarize* any law, or chat with it ("does this apply if the car was a gift?").
  - *Analyst tab*: describe your situation ("my friend says I haven't inherited this money, I think I did") and get relevant state + federal citations explained, plus one-click searches of the official databases.
  - To protect the shared free quota, AI requires sign-in by default (`AI_REQUIRE_ACCOUNT`) and each user (or IP) is capped per hour (`AI_REQUESTS_PER_HOUR`, default 30). Failed calls don't count, and provider errors are logged on the server rather than shown to users.

## Deploy (free): Render + MongoDB Atlas

Nothing runs on your own computer: the app runs on a free Render web service, accounts live in a free MongoDB Atlas cluster, and the law search index is downloaded from this repo's GitHub release.

1. **Build the search index (once).** In this repo go to *Actions → Build law search index → Run workflow*. It takes about an hour for all states and publishes the `index` release; afterwards it re-runs weekly and only rebuilds when Open US Law publishes a new snapshot.
2. **MongoDB Atlas.** Create a free **M0** cluster at [mongodb.com/atlas](https://www.mongodb.com/cloud/atlas/register). Add a database user, then under *Network Access* allow `0.0.0.0/0`, because Render's IPs change. Copy the `mongodb+srv://…` connection string.
3. **Render.** At [dashboard.render.com](https://dashboard.render.com) choose *New → Blueprint*, connect this GitHub repo, and Render reads `render.yaml`. When asked, fill in:
   - `MONGODB_URI`: the Atlas connection string
   - `AI_API_KEY`: your free Gemini key (plus `AI_PROVIDER` if not Gemini)
   - optional: `OPENSTATES_API_KEY`, `GOVINFO_API_KEY` (leave blank to skip)
4. Share the URL Render gives you, `https://<name>.onrender.com`. Every push to `master` redeploys automatically.

Free Render services sleep after 15 minutes without visitors. The next visit wakes the service in about a minute, and the US Code and California indexes are downloaded again in the background (other states on their first search). The `Dockerfile` also works on any Docker host.

## Run locally

Requires Node.js 22.13+ (uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env   # then set AI_API_KEY (and optionally OPENSTATES_API_KEY / GOVINFO_API_KEY)
npm start              # http://localhost:3000
```

Accounts, sessions and reading history go to **MongoDB** when `MONGODB_URI` is set, and otherwise to a local SQLite file, `data/lawlens.db`, which is handy for development. The law search index is a local cache in `data/index/` (one file per jurisdiction). Neither is ever committed to git. `test/api-smoke.sh [url]` checks sign-up, login, settings and reading history against a running server.

### AI setup

1. Get a free key, e.g. [Google AI Studio](https://aistudio.google.com/apikey) (Gemini), [Groq](https://console.groq.com/keys) or [OpenRouter](https://openrouter.ai/keys).
2. In `.env` set `AI_PROVIDER=gemini` (or `groq` / `openrouter`) and `AI_API_KEY=…`. `AI_MODEL` is optional.
3. Restart the server. The Settings page shows "Provided free by this site" when AI is active.

## Licensing of the law text

Laws themselves are public domain (*Georgia v. Public.Resource.Org*, 2020). The compiled Open US Law dataset is published under **CC BY-NC 4.0** — free for personal, research, legal-aid and other non-commercial use with attribution (LawLens credits it on every section). Commercial use of that data needs a licence from Vaquill AI. Every section links to its official government publisher.

## Stack

Express backend (`server/`) with MongoDB or SQLite for accounts and SQLite FTS5 for the law index (prebuilt by `scripts/build-index.mjs`), plus a dependency-free vanilla JS front end (`public/`). Passwords are hashed with scrypt; sessions are HttpOnly cookies.
