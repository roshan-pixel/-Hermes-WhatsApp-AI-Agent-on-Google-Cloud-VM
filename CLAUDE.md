# Hermes WhatsApp AI Agent - Architecture & System Guide

This project is mapped by Graphify. The full knowledge graph report is at `graphify-out/GRAPH_REPORT.md` and the interactive visual graph is at `graphify-out/graph.html`.

## Core System Architecture & God Nodes
- **`index.js`**: Core runtime orchestrator. Houses the WhatsApp client (`wwebjs`), HTTP pairing/health server, multi-turn state machines, and the inbound message pipeline.
- **`generateAIReply()` & `getDeepSeekReply()`**: Primary LLM response engine. Primary model is `deepseek-chat` with Google Gemini (`gemini-2.5-flash`) as backup.
- **`analyzeImageWithVision()`**: Google Cloud Vision API integration (text OCR, object localization, scene labeling) with Gemini Multimodal fallback.
- **`emailService.js`**: Autonomous email dispatcher using Gmail SMTP (App Password) for drafts and direct dispatch.
- **`chatMemory.js`**: Graph memory loader and semantic query engine (`chat-memory-graph/graph.json`).
- **`scripts/patch-wwebjs.js`**: Custom monkey-patch for `whatsapp-web.js` fixing CDP evaluate loop crashes and Frame Navigation errors on headless Chromium.

## Critical Guidelines
1. **DeepSeek Token Conservation**:
   - Keep WhatsApp responses crisp, user-friendly, and concise (under 250-350 tokens).
   - NEVER dump raw OCR text, unformatted scans, or full memory nodes into chat history or WhatsApp responses.
   - When users send photos/documents/scans, provide an intelligent, structured 10/10 summary with key takeaways and details.
2. **Conversation & Memory Filtering**:
   - Recalled memories from Graphify must only act as subtle background context. Never copy-paste or regurgitate past memory nodes unless explicitly asked.
   - Separate conversational mentions of email from explicit actions to send/draft email.
3. **Owner (Roshan) Context**:
   - When the message is from Roshan (owner), the AI assistant is speaking directly to Roshan—not managing messages on his behalf in third person.

## Newer modules (Oct 2026)
- **`reportBot.js` / `diseaseGuide.js`**: Mizoram Bonanza members only; `/report` flow, strict report-only guard rails, product guide in `data/disease_guide.json`.
- **`broadcast.js` + `sender/`**: owner-only `/broadcast` -> preview -> `/confirm`; sending goes through the Baileys sender (a second linked device).
- **Owner**: `+91 8058363027`. Never grant access from names; use numbers / WhatsApp ids.
- **Storage / OCR**: Tencent COS and Tencent Cloud OCR (Tesseract fallback). No API keys in code.
- **`billing.js` / `ledger.js`** (driven from `reportBot.js`): watched members (`WATCHED_MEMBERS`, default LALREMSIAMI) send payment slips + invoice screenshots; files are batched 45 s, OCR'd, reconciled (DS id, name, amount, slip coverage, MATCHED/MISMATCH), mailed to `BILLING_FORWARD_TO`, summarised to the owner on WhatsApp, and on MATCHED the live ledger's invoice remarks are replaced (old text backed up in `data/ledger-remark-backup.jsonl`). Bot remarks end with "✅ Auto-updated via WhatsApp (Hermes)", which the ledger page shows as a yellow "✅ WA" box. Owner test mode: `data/test-forward.json` = {"until": <ms>}.
