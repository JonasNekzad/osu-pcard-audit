# OSU P-card Audit Console

This project satisfies Part IV of the P-card assignment with two auditor-facing tabs:

1. **Ask the database** converts a natural-language audit question into a read-only SQLite query, displays the SQL, and returns up to 500 rows.
2. **Prohibited-purchase dashboard** lets auditors select a year and run separate keyword searches against either `Description` or `Vendor`.

The application treats every match as a risk indicator requiring follow-up. It does not label a transaction as fraud or a confirmed violation.

## Run locally

Requirements: Node.js 22 or later. The project has no third-party runtime packages.

```bash
cp .env.example .env
# Add your own OPENAI_API_KEY to .env, then export it in your shell.
export OPENAI_API_KEY="your-key"
npm start
```

Open `http://localhost:3000`.

The server uses `data/pcards.db.gz` and decompresses it to the operating system's temporary directory. For development, you can bypass decompression:

```bash
PCARDS_DB_PATH="/absolute/path/to/pcards.db" OPENAI_API_KEY="your-key" npm start
```

## Deploy on Render

### 1. Create the GitHub repository

Create an empty repository in your GitHub account, then run these commands from this project folder. Replace the two placeholders in angle brackets; do not add an API key to any Git command or file.

```bash
git init
git add .
git commit -m "Complete OSU P-card audit website"
git branch -M main
git remote add origin https://github.com/<YOUR-USERNAME>/<YOUR-REPOSITORY>.git
git push -u origin main
```

Copy the repository URL for your submission.

### 2. Deploy the live website

1. In Render, choose **New Web Service** and connect the GitHub repository. The included `render.yaml` supplies the start command.
2. Add `OPENAI_API_KEY` as a **secret** environment variable. Never add its value to a file or Git commit.
3. Optionally set `OPENAI_MODEL`; the default is `gpt-5.6-luna`.
4. Deploy, open both tabs, and run one dashboard search and one natural-language question.
5. Copy the live Render URL into the assignment submission.

The natural-language implementation uses the OpenAI Responses API with Structured Outputs. See the official [text generation guide](https://developers.openai.com/api/docs/guides/text) and [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs).

## Security controls

- SQLite is opened read-only and `PRAGMA query_only` is enabled.
- Generated SQL must begin with `SELECT` or `WITH`.
- Writes, DDL, PRAGMA statements, comments, and multiple statements are rejected.
- Generated output is capped at 500 displayed rows.
- Dashboard searches use bound parameters.
- Access to SQLite internal tables and file helper functions is rejected.
- `.env` and raw `.db` files are excluded from Git.
- API keys are read only from deployment environment variables.

## Tests

```bash
npm test
```

The tests verify the SQL safety gate and wildcard escaping. The health, metadata, and dashboard endpoints can be smoke-tested without an API key; the natural-language endpoint requires one.
