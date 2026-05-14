# Project Stabilization Summary: AI Chat Relay

This document summarizes the engineering efforts and architectural improvements made to stabilize the AI Chat Relay extension and server.

## 🚀 Key Accomplishments

### 1. Standardized Provider Architecture
The **ChatGPT** and **Gemini** providers have been fully stabilized:
- **Shadow-Piercing**: Implemented recursive DOM traversal to "see through" Shadow Roots and interact with encapsulated web components.
- **Interaction Hardening**: Implemented "Deep-Typing" logic that fires `beforeinput`, `input`, and `composition` events to ensure React-based UI states update correctly.
- **Geometrical Precision**: Replaced unreliable visibility checks with `getBoundingClientRect()` to accurately identify visible interaction targets.

### 2. High-Fidelity Capture (DOM-First)
- **Gemini Stabilization**: Switched to DOM-first capture by default to bypass Service Worker debugger limitations.
- **Forced Completion**: Implemented "Dead-End Detection" that force-finalizes an API response if the screen text hasn't changed for 3 seconds.

### 3. Server & Background Reliability
- **Stateful Buffering**: The `api-relay-server` now buffers partial responses, only resolving HTTP requests once the "Final" signal is received from the extension.
- **Smart Routing**: The background script now routes messages to specific tabs based on the requested model (e.g., Gemini requests only go to Gemini-supported tabs).
- **Self-Healing Tabs**: Implemented automatic script re-injection to fix "Extension context invalidated" errors.

## 🧪 Testing & Deployment Procedure

Whenever a change is made to the source code, follow this sequence to ensure the system is correctly synchronized:

1.  **Restart the Relay Server**:
    - Stop the current process (`Ctrl+C`).
    - Run `npm run dev` in the `api-relay-server` directory.
    - *Required if `server.ts` or server logic changed.*

2.  **Reload the Chrome Extension**:
    - Open `chrome://extensions/` in your browser.
    - Find the "AI Chat Relay" extension.
    - Click the **Refresh (⟳)** icon.
    - *Required if any file in the `extension/` folder changed.*

3.  **Refresh AI Web Interfaces**:
    - Go to your open Claude, Gemini, or ChatGPT tabs.
    - Perform a full page refresh (`Ctrl+R` or `F5`).
    - *Required after an extension reload to inject the new provider logic.*

4.  **Execute Test Commands**:
    - Run the provided `curl` commands in your terminal to verify end-to-end connectivity.

## 📝 TODO: Claude Provider Stabilization
The Claude module requires a dedicated stabilization phase to reach parity with Gemini/ChatGPT. The following technical hurdles must be addressed:

1.  **Input Detection Overhaul**:
    *   Implement Shadow-aware sidebar detection to prevent the extension from targeting navigation search boxes.
    *   Add support for both `div[contenteditable]` (ProseMirror) and `textarea` targets.
2.  **Interaction Reliability**:
    *   Implement the "Deep-Typing" event sequence (`beforeinput` -> `input` -> `composition`).
    *   Add a multi-level "Send" fallback: Primary Button -> Native Form Submit -> Enter Key Sequence (Down/Press/Up).
3.  **Clean Response Capture**:
    *   Lock the DOM monitor to the central chat container to avoid capturing "UI noise" (model names, plan info).
    *   Implement prompt-stripping to ensure the API only receives the AI's response text.

## 🔍 Debugging & Maintenance
Each provider now features a **"Total Audit"** mode. During a send attempt, it logs detailed metadata for every input and button it finds to the browser console.

### Troubleshooting Hooks:
- **Console Logs**: Look for `[GeminiProvider]` or `[BG RELAY]` tags.
- **State Inspection**: Use `window.CHAT_RELAY_DEBUG` in the browser console.

## 📋 Next Steps
- [ ] **Claude Stabilization**: Execute the roadmap above.
- [ ] **Streaming Support**: Transition to MutationObserver-based streaming.
- [ ] **Multi-Tab Concurrency**: Map socket IDs to specific browser tab IDs.

---
**Last Updated**: 2026-05-14
**Version**: 1.1 (Stable - Gemini/ChatGPT Only)
