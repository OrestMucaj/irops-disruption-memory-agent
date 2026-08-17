# Submission — CockroachDB × AWS Hackathon

Everything needed to submit, in one place. Deadline **18 Aug 2026**.

---

## Links to paste into Devpost

| Field | Value |
|---|---|
| **Live demo** | `https://irops-memory-demo-21.s3.us-east-1.amazonaws.com/index.html` |
| **Repository** | https://github.com/OrestMucaj/irops-disruption-memory-agent |
| **API health check** | `https://7p2mkku36rbgbj2chqcsers5qy0gkccu.lambda-url.us-east-1.on.aws/api/health` |
| **Video** | *(upload to YouTube or Vimeo as **Public**, then paste the link here)* |

> The `/index.html` suffix is required — see the [Live demo](README.md#live-demo)
> note. Test the exact string you paste, in a private window, before submitting.

---

---

## One-paragraph description

> An operational-memory agent for airline irregular-operations desks. When a
> flight is disrupted, the agent embeds the case, runs a hybrid vector search
> over past disruptions in CockroachDB — semantic similarity and a hard status
> filter pushed into the same index via a prefix column — and proposes typed,
> reviewable actions that cite the specific past cases they lean on, along with
> the outcomes those cases produced. A human approves, edits or rejects; the
> decision is recorded, including the overrules. When the case closes, the
> outcome is embedded in the same transaction as the state write and becomes
> retrievable precedent for the next disruption. Memory is the product, not a
> feature. Built on CockroachDB Cloud (vector index, SERIALIZABLE transactions,
> Managed MCP Server, Agent Skills) and AWS (Lambda Function URL, Bedrock Titan
> Embeddings V2 and Nova Lite, S3).

---

---

## Pre-flight checks

Run these the morning of submission — the demo has to survive a month of
judging, not just today.

```bash
curl -s https://7p2mkku36rbgbj2chqcsers5qy0gkccu.lambda-url.us-east-1.on.aws/api/health
```

- [ ] Health returns `200` with `analyst: true`
- [ ] Demo URL loads in a **private window** (no cache, no logged-in state)
- [ ] Icons render — no empty squares (fonts live in `web/vendor/fonts/`)
- [ ] ZZ1137 shows grouped actions, precedent chips, and a pending count in the
      sticky bar (use **Re-run agent** on the case if it shows none)
- [ ] Chat bubble answers a question and shows its SQL
- [ ] A case can still be resolved end to end
- [ ] `npm run verify:schema` still prints the `prefix spans` line
- [ ] README renders on GitHub — **both mermaid diagrams draw**

---

## Repo hygiene

- [ ] `.env` is not committed (`git check-ignore .env` prints the path)
- [ ] `git status` clean, everything pushed
- [ ] LICENSE present (MIT)

---

## Security — checked, and deliberately deferred

The CockroachDB SQL password was printed to a console during an early deploy
failure, when the AWS CLI echoed an unparseable request payload. Verified before
publishing rather than assumed:

- `.env` has **never** been committed — `git log --all --full-history -- .env`
  returns nothing.
- No commit in the repository contains a real connection string. The only match
  across all history is `.env.example`, which reads
  `postgresql://USERNAME:PASSWORD@HOST:26257/...` — placeholders, and it does
  not contain the real password.

So making the repository public exposes nothing. The credential reached a local
terminal and nowhere else.

**Rotation is deferred until after judging, on purpose.** It requires a full
`deploy.ps1` run to rewrite the Lambda environment, and doing that the night
before submission risks breaking a working demo to close a leak that never left
the machine. The cluster holds only synthetic data; the worst case is a dead
demo link, not a data breach.

- [ ] **After judging closes**, rotate the password in the CockroachDB Cloud
      console, update `.env`, and redeploy:
      ```
      powershell -File scripts/deploy.ps1 -RoleArn <role-arn> -BucketName irops-memory-demo-21
      ```
      **Omit `-CodeOnly`** — environment variables are only rewritten on a full
      deploy.

---

---

## What to claim, and what not to

**Claim:** vectors and transactional rows in one system with no ETL and no
consistency gap; the structured filter pushed *into* the vector index via a
prefix column (`npm run verify:schema` prints the proof); model-authored SQL
confined to a governed read-only MCP path that never touches the application's
connection pool; every agent run recorded including failures.

**Do not claim:** that CockroachDB vector indexing is GA — the docs say Preview
and no GA statement was found; that the retrieval benchmark shows the real
embedder beating the fake one — it does not, and [NOTES.md](NOTES.md) §4A.4
explains why the metric favours lexical matching; that the analyst is reliable
— it is checkable, which is a different and more honest claim.
