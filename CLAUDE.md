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
