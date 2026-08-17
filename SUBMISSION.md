# Submission — CockroachDB × AWS Hackathon

Everything needed to submit, in one place. Deadline **18 Aug 2026**.

---

## Links to paste into Devpost

| Field | Value |
|---|---|
| **Live demo** | `https://irops-memory-demo-21.s3.us-east-1.amazonaws.com/index.html` |
| **Repository** | *(push and paste the URL)* |
| **API health check** | `https://7p2mkku36rbgbj2chqcsers5qy0gkccu.lambda-url.us-east-1.on.aws/api/health` |
| **Video** | *(upload, unlisted is fine, paste the link)* |

> The `/index.html` suffix is required — see the [Live demo](README.md#live-demo)
> note. Test the exact string you paste, in a private window, before submitting.

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

## Video — 2:45 shot list

Record at 1440×900 or wider so the sidebar and the plan fit without scrolling.
Have ZZ1137 open in a second tab so no step waits on a page load.

| Time | Shot | Say |
|---|---|---|
| 0:00–0:20 | Caseload view, KPI row | "An airline ops desk handles every disruption from scratch. The knowledge of what actually worked last time lives in people's heads. This stores the judgement, not just the records." |
| 0:20–0:40 | Click **ZZ1137** — 190′ late, 23 misconnecting | "A real disruption: 147 passengers, 23 misconnecting. The agent has already searched past disruptions." |
| 0:40–1:15 | **Recommended plan** — hover the grouped cards, then click a precedent chip | "Twelve rebookings as one decision, not twelve. Each group cites the past disruptions it leaned on — this one is ZZ4381, which scored 5 out of 5. Click it and you see what that desk actually did and how it turned out." |
| 1:15–1:35 | **Approve all 13** → sticky bar turns green | "Nothing happens without a human. Approve, edit, or reject — and the rejections are kept, because an overrule is the strongest signal in the dataset." |
| 1:35–1:55 | **Evidence → Agent run** tab | "Every run is recorded: the model, the tokens, and the exact case ids the plan was built from. Including failures." |
| 1:55–2:20 | **Chat bubble** → ask *"which cause had the worst average outcome rating?"* | "The analyst answers by writing SQL that runs read-only through CockroachDB's Managed MCP Server. You see the statement and the rows it returned — the answer comes with its evidence attached." |
| 2:20–2:45 | **Close the loop** → resolve with an outcome note → back to Memory view | "Record what happened, and it is embedded in the same transaction as the state write. It is now precedent the next disruption will retrieve. That is the loop closing." |

**Do not** narrate the architecture. Show the loop closing; the README carries
the wiring.

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
- [ ] ZZ1137 shows grouped actions with precedent chips
- [ ] Chat bubble answers a question and shows its SQL
- [ ] A case can still be resolved end to end
- [ ] `npm run verify:schema` still prints the `prefix spans` line
- [ ] README renders on GitHub — **both mermaid diagrams draw**

## Repo hygiene

- [ ] `.env` is not committed (`git check-ignore .env` prints the path)
- [ ] `git status` clean, everything pushed
- [ ] LICENSE present (MIT)

## Security

- [ ] **Rotate the CockroachDB SQL password.** It was printed to a console
      during an early deploy failure. Rotate in the CockroachDB Cloud console,
      update `.env`, then redeploy so Lambda picks up the new value:
      ```
      powershell -File scripts/deploy.ps1 -RoleArn <role-arn> -BucketName irops-memory-demo-21
      ```
      Note: **omit `-CodeOnly`** — the environment variables are only rewritten
      on a full deploy.
- [ ] Re-run the health check after rotating

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
