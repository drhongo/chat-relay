# Kimi K2 Provider Architecture

This document describes the `KimiK2Provider` used by the extension to automate the Kimi K2 chat interface.

---

## 🧩 Overview

`KimiK2Provider` is modeled after the existing AI Studio and ChatGPT providers. It sends messages and captures responses from `kimi.com` using DOM based monitoring by default with an optional debugger fallback.

---

## ⚙️ Configurable Options

```js
this.captureMethod = 'dom'; // or 'debugger'
this.debuggerUrlPattern = '*kimi.com/api/chat*';
this.includeThinkingInMessage = false;
```

---

## 📌 DOM Selectors

- Input field: `textarea, div[contenteditable="true"]`
- Send button: `button[type="submit"], button.send-btn`
- Response blocks: `.message.ai, .chat-message.ai`
- Typing indicator: `.typing, .loading`

---

## ✅ Summary

The provider offers a lightweight integration with Kimi K2 using the same structure as the other providers. It can capture responses via DOM observation or via Chrome debugger when configured.
