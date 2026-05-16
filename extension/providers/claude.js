/*
 * Chat Relay: Relay for AI Chat Interfaces
 * Copyright (C) 2025 Jamison Moore
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see https://www.gnu.org/licenses/.
 */
// AI Chat Relay - Claude Provider

class ClaudeProvider {
  constructor() {
    // --- START OF CONFIGURABLE PROPERTIES ---
    // Method for response capture: "debugger" or "dom"
    this.captureMethod = "dom"; // DOM is more reliable for Claude.ai
    // URL pattern for debugger to intercept if captureMethod is "debugger". Ensure this is specific.
    this.debuggerUrlPattern = "*://claude.ai/api/organizations/*/conversations/*/completion*";
    // Whether to include "thinking" process in the message or just the final answer.
    // If true, parseDebuggerResponse returns a JSON string: { "thinking": "...", "answer": "..." }
    // If false, parseDebuggerResponse returns a string: "answer"
    this.includeThinkingInMessage = false;
    // --- END OF CONFIGURABLE PROPERTIES ---

    this.name = "ClaudeProvider";
    this.supportedDomains = ["claude.ai"];

    // Selectors for the Claude interface
    // Input: data-testid="chat-input" is the Tiptap editor Claude actually uses
    this.inputSelector = '[data-testid="chat-input"], div.ProseMirror[contenteditable="true"], .tiptap.ProseMirror, .ProseMirror';
    // Send button: appears after typing; Claude uses aria-label="Send message" on the submit button
    // Also try by position — the last button inside the input container
    this.sendButtonSelector = 'button[aria-label*="Send message" i], button[aria-label*="send message" i], button[aria-label="Send Message"], [data-testid="send-button"]';
    this.newChatSelector = '[data-testid*="new-chat"], a[href="/new"], [aria-label*="New chat" i], [aria-label*="Start a new chat" i]';

    // Updated response selectors based on the actual elements
    this.responseSelector = '.font-claude-response-body, .standard-markdown, [data-testid="assistant-message"], .font-claude-message, [data-testid="message-container"], .model-response, .model-response-container, ms-chat-turn, .very-large-text-container, .cmark-node, .claude-message, div.prose';

    // Thinking indicator selector
    this.thinkingIndicatorSelector = '.thinking-indicator, .loading-indicator, .typing-indicator, .response-loading, .loading, [aria-label*="Stop" i], [data-testid="stop-button"], button[aria-label*="Stop"]';

    // Fallback selectors
    this.responseSelectorForDOMFallback = '.font-claude-message, [data-testid="message-container"], .claude-message';
    this.thinkingIndicatorSelectorForDOM = '.thinking-indicator, .loading, .spinner, .loading-indicator';

    // Last sent message to avoid capturing it as a response
    this.lastSentMessage = '';

    // Initialize pendingResponseCallbacks
    this.pendingResponseCallbacks = new Map();
    this.requestAccumulators = new Map(); // To accumulate text for each request
    this.domFallbackTimeout = 15000;
    this.domFallbackTimer = null;
    this.domMonitorTimer = null;

    this._loadSettings();
    console.log(`[${this.name}] Provider initialized.`);
  }

  _loadSettings() {
    chrome.storage.sync.get({ claudeCaptureMethod: 'dom' }, (items) => {
      this.captureMethod = items.claudeCaptureMethod;
      console.log(`[${this.name}] Capture method updated to: ${this.captureMethod}`);
    });
  }

  // Send a message to the chat interface
  async sendChatMessage(messageContent, messageOrId) {
    const requestId = typeof messageOrId === 'object' ? messageOrId.requestId : messageOrId;
    console.log(`[${this.name}] sendChatMessage called for requestId ${requestId}`);

    // Robust check for New Chat request
    if (typeof messageOrId === 'object' && messageOrId.settings && messageOrId.settings.new_chat) {
        const currentPath = window.location.pathname;
        const isOnFreshPage = currentPath === '/new' || currentPath === '/' || currentPath === '';
        const hasNoMessages = document.querySelectorAll('[data-testid="user-message"]').length === 0;

        if (isOnFreshPage && hasNoMessages) {
            // Already on a fresh chat with no messages — skip navigation
            console.log(`[${this.name}] New Chat requested but already on fresh empty page. Skipping.`);
        } else {
            // On an existing conversation or fresh page that already has messages — start a new chat
            console.log(`[${this.name}] New Chat requested. Current path: ${currentPath}. Attempting to navigate.`);
            const newChatButtons = this._findDeep(document, this.newChatSelector);
            if (newChatButtons.length > 0) {
                const newChatButton = newChatButtons[0];
                console.log(`[${this.name}] Found New Chat button, clicking...`);
                const rect = newChatButton.getBoundingClientRect();
                const clientX = rect.left + rect.width / 2;
                const clientY = rect.top + rect.height / 2;

                newChatButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', clientX, clientY }));
                newChatButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX, clientY }));
                newChatButton.focus();
                newChatButton.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', clientX, clientY }));
                newChatButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX, clientY }));
                newChatButton.click();

                await new Promise(resolve => setTimeout(resolve, 3000));
            } else {
                // Fallback: navigate directly to /new
                console.log(`[${this.name}] New Chat button not found, navigating to /new...`);
                window.location.href = "https://claude.ai/new";
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }

    // 1. Polling for Input Field using shadow-piercing search
    let inputField = null;
    let pollAttempts = 0;
    const maxPollAttempts = 15;

    while (pollAttempts < maxPollAttempts) {
        const inputFields = this._findDeep(document, this.inputSelector);
        if (inputFields.length > 0) {
            inputField = inputFields[0];
            console.log(`[${this.name}] Input field found after ${pollAttempts + 1} attempts.`);
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        pollAttempts++;
    }

    if (!inputField) {
      console.error(`[${this.name}] Missing input field. Selector: ${this.inputSelector}`);
      this._reportSendError(requestId, "Input field not found after polling.");
      return false;
    }

    try {
      this.lastSentMessage = ""; // Will be set below

      let textToInput = "";
      let blobToPaste = null;
      let blobMimeType = "image/png";

      if (typeof messageContent === 'string') {
        textToInput = messageContent;
        this.lastSentMessage = textToInput;
      } else if (messageContent instanceof Blob) {
        blobToPaste = messageContent;
        blobMimeType = messageContent.type || blobMimeType;
        this.lastSentMessage = `Blob data (${blobMimeType}, size: ${blobToPaste.size})`;
      } else if (Array.isArray(messageContent)) {
        for (const part of messageContent) {
          if (part.type === "text" && typeof part.text === 'string') {
            textToInput += (textToInput ? "\n" : "") + part.text;
          } else if (part.type === "image_url" && part.image_url && typeof part.image_url.url === 'string') {
            if (!blobToPaste) {
              try {
                const response = await fetch(part.image_url.url);
                blobToPaste = await response.blob();
                blobMimeType = blobToPaste.type || blobMimeType;
              } catch (e) {
                console.error(`[${this.name}] Error fetching image_url:`, e);
              }
            }
          }
        }
        this.lastSentMessage = textToInput || "Array content with image";
      }

      // 2. Insert Text into Input Field (Tiptap editor)
      if (textToInput) {
        inputField.focus();
        await new Promise(resolve => setTimeout(resolve, 200));

        let insertSucceeded = false;

        // Method 1: Clipboard paste — most reliable for Tiptap
        try {
            const dt = new DataTransfer();
            dt.setData('text/plain', textToInput);
            inputField.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
            await new Promise(resolve => setTimeout(resolve, 200));
            const afterPaste = (inputField.innerText || inputField.textContent || "").trim();
            if (afterPaste.length > 0) {
                insertSucceeded = true;
                console.log(`[${this.name}] Text inserted via paste. Content: "${afterPaste.substring(0, 60)}"`);
            }
        } catch (e) {
            console.warn(`[${this.name}] Paste failed: ${e.message}`);
        }

        // Method 2: execCommand insertText
        if (!insertSucceeded) {
            try {
                document.execCommand('selectAll', false, null);
                document.execCommand('delete', false, null);
                document.execCommand('insertText', false, textToInput);
                await new Promise(resolve => setTimeout(resolve, 200));
                if ((inputField.innerText || "").trim().length > 0) {
                    insertSucceeded = true;
                    console.log(`[${this.name}] Text inserted via execCommand.`);
                }
            } catch (e) {
                console.warn(`[${this.name}] execCommand failed: ${e.message}`);
            }
        }

        // Method 3: Simulate keyboard typing character by character (slow but reliable)
        if (!insertSucceeded) {
            console.log(`[${this.name}] Trying keyboard simulation...`);
            inputField.focus();
            // Clear first
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            // Type character by character
            for (const char of textToInput.substring(0, 500)) { // limit to 500 chars for perf
                document.execCommand('insertText', false, char);
            }
            await new Promise(resolve => setTimeout(resolve, 100));
            if ((inputField.innerText || "").trim().length > 0) {
                insertSucceeded = true;
                console.log(`[${this.name}] Text inserted via keyboard simulation.`);
            }
        }

        if (!insertSucceeded) {
            console.error(`[${this.name}] All text insertion methods failed!`);
        }

        // Trigger input event so Tiptap/React enables the send button
        inputField.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));

        const verifiedText = (inputField.innerText || inputField.textContent || "").trim();
        console.log(`[${this.name}] Input field after insertion: "${verifiedText.substring(0, 80)}"`);
      } else {
        inputField.textContent = "";
        inputField.dispatchEvent(new Event('input', { bubbles: true }));
      }

      if (blobToPaste) {
        const dataTransfer = new DataTransfer();
        const file = new File([blobToPaste], "image." + (blobMimeType.split('/')[1] || 'png'), { type: blobMimeType });
        dataTransfer.items.add(file);
        inputField.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true }));
      }

      // 3. Polling for Send Button (Wait for it to appear/be enabled after typing)
      let sendButton = null;
      let buttonPollAttempts = 0;
      const maxButtonPollAttempts = 10;

      while (buttonPollAttempts < maxButtonPollAttempts) {
        // First try specific selectors
        let sendButtons = this._findDeep(document, this.sendButtonSelector);

        // Fallback: find nearest enabled button to the input field container
        if (sendButtons.length === 0) {
            const inputContainer = inputField.closest('form, [class*="input"], [class*="composer"], [class*="footer"], fieldset') || inputField.parentElement;
            if (inputContainer) {
                const nearbyButtons = Array.from(inputContainer.querySelectorAll('button'));
                const enabledNearby = nearbyButtons.filter(b =>
                    !b.disabled &&
                    b.getAttribute('aria-disabled') !== 'true' &&
                    b.type !== 'button' || b.getAttribute('aria-label') // prefer labeled buttons
                );
                if (enabledNearby.length > 0) {
                    sendButtons = enabledNearby;
                }
            }
        }

        if (sendButtons.length > 0) {
            sendButton = sendButtons[sendButtons.length - 1];
            const isDisabled = sendButton.disabled ||
                               sendButton.getAttribute('aria-disabled') === 'true' ||
                               sendButton.classList.contains('opacity-50') ||
                               sendButton.classList.contains('pointer-events-none');

            if (!isDisabled) {
                console.log(`[${this.name}] Enabled send button found. aria-label: "${sendButton.getAttribute('aria-label')}"`);
                break;
            }
        }
        console.log(`[${this.name}] Waiting for send button (attempt ${buttonPollAttempts + 1}). Found: ${sendButtons.length}`);
        // Re-dispatch input events to help UI update
        inputField.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 1000));
        buttonPollAttempts++;
      }

      if (!sendButton) {
        console.error(`[${this.name}] Send button not found or remained disabled.`);
        this._reportSendError(requestId, "Send button not found or disabled.");
        return false;
      }

      // 4. Click Send Button
      inputField.focus();
      await new Promise(resolve => setTimeout(resolve, 300));

      let attempts = 0;
      const maxAttempts = 5;
      while (attempts < maxAttempts) {
        const isDisabled = sendButton.disabled ||
                           sendButton.getAttribute('aria-disabled') === 'true' ||
                           sendButton.classList.contains('opacity-50') ||
                           sendButton.classList.contains('pointer-events-none');

        console.log(`[${this.name}] Send button check before click (attempt ${attempts + 1}). Disabled: ${isDisabled}`);

        if (!isDisabled) {
          console.log(`[${this.name}] Clicking send button.`);
          const rect = sendButton.getBoundingClientRect();
          const clientX = rect.left + rect.width / 2;
          const clientY = rect.top + rect.height / 2;

          const options = { bubbles: true, cancelable: true, clientX, clientY, view: window };

          sendButton.dispatchEvent(new PointerEvent('pointerdown', { ...options, pointerType: 'mouse' }));
          sendButton.dispatchEvent(new MouseEvent('mousedown', options));
          sendButton.focus();
          sendButton.click();
          sendButton.dispatchEvent(new PointerEvent('pointerup', { ...options, pointerType: 'mouse' }));
          sendButton.dispatchEvent(new MouseEvent('mouseup', options));
          sendButton.dispatchEvent(new MouseEvent('click', options));

          // Trigger Enter key as fallback after a short delay
          setTimeout(() => {
              const enterOptions = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
              inputField.dispatchEvent(new KeyboardEvent('keydown', enterOptions));
              inputField.dispatchEvent(new KeyboardEvent('keypress', enterOptions));
              inputField.dispatchEvent(new KeyboardEvent('keyup', enterOptions));
          }, 100);

          return true;
        }
        attempts++;
        inputField.dispatchEvent(new Event('input', { bubbles: true }));
        inputField.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      this._reportSendError(requestId, "Send button remained disabled after polling.");
      return false;
    } catch (error) {
      console.error(`[${this.name}] Error sending message:`, error);
      this._reportSendError(requestId, error.message);
      return false;
    }
  }

  _reportSendError(requestId, errorMessage) {
    const callback = this.pendingResponseCallbacks.get(requestId);
    if (callback) {
        callback(requestId, `[PROVIDER_SEND_ERROR: ${errorMessage}]`, true);
        this.pendingResponseCallbacks.delete(requestId);
    }
  }

  _findDeep(root, selector) {
    const elements = Array.from(root.querySelectorAll(selector));
    const shadowElements = Array.from(root.querySelectorAll('*'))
        .filter(el => el.shadowRoot)
        .flatMap(el => this._findDeep(el.shadowRoot, selector));
    return [...elements, ...shadowElements];
  }

  async initiateResponseCapture(requestId, responseCallback) {
    console.log(`[${this.name}] initiateResponseCapture called for requestId: ${requestId}. Capture method: ${this.captureMethod}`);
    this.pendingResponseCallbacks.set(requestId, responseCallback);

    // Reset accumulator for this request
    this.requestAccumulators.set(requestId, { text: "", isDefinitelyFinal: false });

    if (this.captureMethod === "debugger") {
      const patterns = this.getStreamingApiPatterns();
      await new Promise(resolve => {
        chrome.runtime.sendMessage({
            type: "SET_DEBUGGER_TARGETS",
            providerName: this.name,
            patterns: patterns
        }, () => resolve());
      });

      if (this.domFallbackTimer) clearTimeout(this.domFallbackTimer);
      // Start DOM monitoring after a delay to allow the message to be sent first.
      // This avoids capturing pre-send DOM state (e.g. sidebar text).
      this.domFallbackTimer = setTimeout(() => {
        const acc = this.requestAccumulators.get(requestId);
        if (acc && !acc.isDefinitelyFinal) {
          console.log(`[${this.name}] Starting DOM monitoring for ${requestId}.`);
          this._startDOMMonitoring(requestId);
        }
      }, 3000); // 3s delay gives time for message send + UI response to start
    } else {
      // DOM-only mode: wait 2s for send to complete and Claude to start responding
      this.domFallbackTimer = setTimeout(() => {
        this._startDOMMonitoring(requestId);
      }, 2000);
    }
  }

  handleDebuggerData(requestId, rawData, isFinalFromBackground, errorFromBackground = null) {
    const callback = this.pendingResponseCallbacks.get(requestId);
    if (!callback) return;

    if (errorFromBackground) {
      console.warn(`[${this.name}] Debugger error: ${errorFromBackground}`);
      callback(requestId, `[Provider Error] ${errorFromBackground}`, true);
      this.pendingResponseCallbacks.delete(requestId);
      this.requestAccumulators.delete(requestId);
      return;
    }

    let accumulator = this.requestAccumulators.get(requestId);
    if (!accumulator) {
      accumulator = { text: "", isDefinitelyFinal: false };
      this.requestAccumulators.set(requestId, accumulator);
    }

    if (accumulator.isDefinitelyFinal) return;

    if (rawData && rawData.trim() !== "") {
        const parseOutput = this.parseDebuggerResponse(rawData, requestId);

        if (accumulator.text.length === 0 && parseOutput.text) {
          console.log(`[${this.name}] SUCCESS: First debugger data received for ${requestId}. Disabling DOM fallback timer.`);
          if (this.domFallbackTimer) {
              clearTimeout(this.domFallbackTimer);
              this.domFallbackTimer = null;
          }
        }

        if (parseOutput.text) {
            accumulator.text += parseOutput.text;
        }

        if (parseOutput.isFinalResponse) {
            // Only finalize if we have text. If text is empty but it's "final",
            // it might mean the debugger missed the data chunks but got the stop signal.
            // In that case, we let DOM fallback handle it.
            if (accumulator.text.length > 0) {
                accumulator.isDefinitelyFinal = true;
            } else {
                console.log(`[${this.name}] Received final signal but text is empty. Waiting for potential more chunks or DOM fallback.`);
            }
        }

        // Only callback if we have text or it's definitely final
        if (accumulator.text.length > 0 || accumulator.isDefinitelyFinal) {
            callback(requestId, accumulator.text, accumulator.isDefinitelyFinal);
        }
    } else if (isFinalFromBackground) {
        console.log(`[${this.name}] Debugger signal: final from background for ${requestId}. Acc len: ${accumulator.text.length}`);

        // If we have some text, we can finalize.
        if (accumulator.text.length > 0) {
            accumulator.isDefinitelyFinal = true;
            callback(requestId, accumulator.text, true);
        } else {
            // Debugger finished with NO text. This is a failure of the debugger method.
            // We DO NOT mark as final here; instead, we let the DOM fallback timer
            // (which was set in initiateResponseCapture) trigger _startDOMMonitoring.
            console.log(`[${this.name}] Debugger finished with NO text. Relying on DOM fallback.`);
        }
    }

    if (accumulator.isDefinitelyFinal) {
      this.pendingResponseCallbacks.delete(requestId);
      this.requestAccumulators.delete(requestId);
    }
  }

  parseDebuggerResponse(sseChunk, requestId = 'unknown') {
    let extractedText = "";
    let isFinal = false;

    // Check for non-SSE content
    const trimmed = sseChunk.trim();
    if (trimmed.startsWith('import ') || trimmed.startsWith('export ') || trimmed.startsWith('function(') || trimmed.length > 50000) { // Increased limit
        return { text: "", isFinalResponse: false };
    }

    const messages = sseChunk.split('\n\n');
    for (const msg of messages) {
        if (!msg.trim()) continue;

        let eventType = null;
        let dataStr = null;
        const lines = msg.split('\n');

        for (const line of lines) {
            if (line.startsWith("event:")) eventType = line.substring(6).trim();
            else if (line.startsWith("data:")) dataStr = line.substring(5).trim();
        }

        if (eventType === "message_stop") {
            isFinal = true;
        } else if (eventType && dataStr) {
            try {
                const data = JSON.parse(dataStr);
                if (eventType === "content_block_delta" && data.delta?.text) {
                    extractedText += data.delta.text;
                } else if (eventType === "message_delta" && data.delta?.stop_reason) {
                    isFinal = true;
                }
            } catch (e) {
                // Ignore parse errors for partial/malformed JSON in stream
            }
        }
    }
    return { text: extractedText, isFinalResponse: isFinal };
  }

  _captureResponseDOM(element = null) {
    if (!element) {
        const sentTrimmed = this.lastSentMessage.trim();
        // Use the LAST user-message element so that in multi-turn conversations
        // we walk siblings from the most recent user turn, not the first one.
        const allUserMsgEls = document.querySelectorAll('[data-testid="user-message"]');
        const userMsgEl = allUserMsgEls.length > 0 ? allUserMsgEls[allUserMsgEls.length - 1] : null;

        if (userMsgEl) {
            // Walk up from the user-message until we find an ancestor that has
            // a SUBSEQUENT sibling containing substantial non-user text.
            // The timestamp "12:00 PM" is a direct sibling at low levels — we need
            // to go higher until the sibling is the full assistant turn.
            let node = userMsgEl;
            for (let depth = 0; depth < 15; depth++) {
                const parent = node.parentElement;
                if (!parent) break;

                // Check all next siblings of node at this level
                let sib = node.nextElementSibling;
                while (sib) {
                    const sibText = (sib.innerText || sib.textContent || "").trim();
                    const isTimestamp = /^(\d{1,2}:\d{2})\s?([APM]{2})?$/i.test(sibText);
                    
                    // Must be non-empty, not a timestamp, and not user message echo
                    if (sibText.length > 0 && !isTimestamp && !sibText.startsWith(sentTrimmed)) {
                        // Prioritize if it has a known response class
                        const hasResponseClass = sib.querySelector('.font-claude-response-body, .standard-markdown') || 
                                               sib.classList.contains('font-claude-response-body') ||
                                               sib.classList.contains('standard-markdown');
                        
                        if (hasResponseClass || !element) {
                            element = sib;
                            console.log(`[${this.name}] Found assistant turn at depth ${depth}, text: "${sibText.substring(0, 80)}"`);
                            if (hasResponseClass) break; // Found the high-quality match
                        }
                    }
                    sib = sib.nextElementSibling;
                }
                if (element) break;
                node = parent;
            }
        }

        if (!element) {
            // Last resort: find any element in the page that has the action-bar-copy/retry
            // buttons as children — those only appear on completed messages
            const retryBtns = Array.from(document.querySelectorAll('[data-testid="action-bar-retry"]'));
            if (retryBtns.length > 0) {
                // The retry button's grandparent or similar should be the assistant message
                let candidate = retryBtns[retryBtns.length - 1];
                for (let i = 0; i < 6; i++) {
                    candidate = candidate.parentElement;
                    if (!candidate) break;
                    const t = (candidate.innerText || candidate.textContent || "").trim();
                    const isTimestamp = /^(\d{1,2}:\d{2})\s?([APM]{2})?$/i.test(t);
                    if (t.length > 0 && !isTimestamp && !t.startsWith(sentTrimmed)) {
                        element = candidate;
                        console.log(`[${this.name}] Found assistant turn via retry button ancestor. Text: "${t.substring(0, 80)}"`);
                        break;
                    }
                }
            }
        }

        if (!element) {
            // Absolute last resort: just find the last element matching our primary response selectors
            const candidates = this._findDeep(document, this.responseSelector);
            if (candidates.length > 0) {
                // Pick the last one that isn't the user message or a timestamp
                for (let i = candidates.length - 1; i >= 0; i--) {
                    const t = (candidates[i].innerText || candidates[i].textContent || "").trim();
                    const isTimestamp = /^(\d{1,2}:\d{2})\s?([APM]{2})?$/i.test(t);
                    if (t.length > 0 && !isTimestamp && !t.startsWith(sentTrimmed)) {
                        element = candidates[i];
                        console.log(`[${this.name}] Found assistant turn via primary selector fallback. Text: "${t.substring(0, 80)}"`);
                        break;
                    }
                }
            }
        }

        if (!element) {
            return { found: false, text: '', isStillGenerating: this._isGenerating() };
        }
    }

    // Clean up the captured text
    const sentTrimmed = this.lastSentMessage.trim();
    let text = (element.innerText || element.textContent || "").trim();

    // CLEANUP: Strip Claude UI noise
    text = this._cleanResponse(text);

    // Strip user message echo if it appears at the start
    if (sentTrimmed && text.startsWith(sentTrimmed)) {
        text = text.slice(sentTrimmed.length).trim();
    }

    const isStillGenerating = this._isGenerating();
    if (text.length > 0) {
        console.log(`[${this.name}] _captureResponseDOM: text length=${text.length}, generating=${isStillGenerating}, preview="${text.substring(0, 80)}"`);
    }

    return { found: text.length > 0, text, isStillGenerating };
  }

  // Helper to strip Claude's UI-specific labels and boilerplate
  _cleanResponse(text) {
      if (!text) return "";
      
      let cleaned = text;

      // 1. Strip known Claude UI prefix labels
      cleaned = cleaned.replace(/^Claude responded:\s*/i, '').trim();
      cleaned = cleaned.replace(/^Claude\s*\n/i, '').trim();
      cleaned = cleaned.replace(/^(Haiku|Sonnet|Opus|Claude)\s[\d.]+\s*\n/i, '').trim();

      // 2. Remove footers/disclaimers
      const footers = [
          /Claude is AI and can make mistakes\./gi,
          /Please double-check responses\./gi,
          /Check for accuracy\./gi,
          /Subscribe to Pro for/gi,
          /Claude [\d.]+ (Haiku|Sonnet|Opus)/gi
      ];

      footers.forEach(regex => {
          cleaned = cleaned.replace(regex, "");
      });

      // 3. Deduplicate repeated paragraphs
      const paras = cleaned.split('\n\n');
      const deduped = paras.filter((para, i) => i === 0 || para.trim() !== paras[i - 1].trim());
      cleaned = deduped.join('\n\n').trim();

      return cleaned.trim();
  }

  _isGenerating() {
    // Claude shows a "Stop response" button only while streaming.
    // Also check for streaming cursor/animation elements.
    const stopButtons = Array.from(document.querySelectorAll('button[aria-label*="Stop" i]'));
    const stopVisible = stopButtons.some(btn => btn.offsetParent !== null && btn.offsetWidth > 0);
    if (stopVisible) return true;

    // Secondary check: look for streaming cursor or animation
    const streamingIndicators = document.querySelectorAll(
        '.streaming-cursor, [class*="cursor-blink"], [class*="streaming"], .loading-dots'
    );
    return streamingIndicators.length > 0;
  }

  getStreamingApiPatterns() {
    return [
        { urlPattern: this.debuggerUrlPattern, requestStage: "Response" },
        { urlPattern: "*://claude.ai/api/organizations/*/conversations/*/completion*", requestStage: "Response" },
        { urlPattern: "*/api/*/conversations/*/completion*", requestStage: "Response" },
        { urlPattern: "*completion*", requestStage: "Response" },
        { urlPattern: "*conversations*", requestStage: "Response" }
    ];
  }

  shouldSkipResponseMonitoring() {
    return false; // We want DOM monitoring to be active as fallback
  }

  stopStreaming(requestId) {
    console.log(`[${this.name}] stopStreaming called for ${requestId}`);
    const callback = this.pendingResponseCallbacks.get(requestId);
    if (callback) {
      const acc = this.requestAccumulators.get(requestId);
      callback(requestId, (acc ? acc.text : "") + "[STREAM_STOPPED_BY_USER]", true);
    }
    this.pendingResponseCallbacks.delete(requestId);
    this.requestAccumulators.delete(requestId);
    this._stopDOMMonitoring();
  }

  async _startDOMMonitoring(requestId) {
    console.log(`[${this.name}] Starting DOM monitoring for requestId: ${requestId}`);
    this._stopDOMMonitoring();

    let lastCapturedText = "";
    let noChangeCount = 0;
    let totalChecks = 0;
    let generationStarted = false; // Track whether we've seen the Stop button appear
    
    // Initial delay to allow Claude to process the send and show generating state
    await new Promise(resolve => setTimeout(resolve, 2000));

    const monitor = () => {
        const callback = this.pendingResponseCallbacks.get(requestId);
        if (!callback) {
            this._stopDOMMonitoring();
            return;
        }

        totalChecks++;

        const isGenerating = this._isGenerating();
        if (isGenerating) generationStarted = true;

        const result = this._captureResponseDOM();
        if (result.found) {
            if (result.text !== lastCapturedText) {
                lastCapturedText = result.text;
                noChangeCount = 0;
                callback(requestId, result.text, false);
            } else {
                noChangeCount++;
            }
        }

        // Finish conditions:
        // 1. Generation was seen to start AND stopped, text stable for 2s
        // 2. Generation never seen (very fast response) — text stable for 4s after monitor start
        // 3. Text hasn't changed for 10s regardless
        // 4. Hard timeout
        const stoppedGenerating = generationStarted && !isGenerating && lastCapturedText.length > 0 && noChangeCount >= 2;
        const fastResponse = !generationStarted && lastCapturedText.length > 0 && noChangeCount >= 4 && totalChecks >= 6;
        const noChangeTimeout = lastCapturedText.length > 0 && noChangeCount >= 10;
        const hardTimeout = totalChecks >= 120;
        const shouldFinalize = stoppedGenerating || fastResponse || noChangeTimeout || hardTimeout;

        if (shouldFinalize) {
            const reason = stoppedGenerating ? 'generating_stopped' : fastResponse ? 'fast_response' : noChangeTimeout ? 'no_change_timeout' : 'hard_timeout';
            console.log(`[${this.name}] DOM monitoring finishing for ${requestId}. Reason: ${reason}. Text len: ${lastCapturedText.length}`);
            if (lastCapturedText.length > 0) {
                callback(requestId, lastCapturedText, true);
            } else {
                callback(requestId, "[Error: No response captured from DOM]", true);
            }
            this.pendingResponseCallbacks.delete(requestId);
            this._stopDOMMonitoring();
        } else {
            this.domMonitorTimer = setTimeout(monitor, 500); // Poll every 500ms
        }
    };
    monitor();
  }

  _stopDOMMonitoring() {
    if (this.domMonitorTimer) {
      clearTimeout(this.domMonitorTimer);
      this.domMonitorTimer = null;
    }
  }
}

// Robust registration
(function register() {
    if (window.providerUtils) {
        console.log("ClaudeProvider: Registering...");
        const providerInstance = new ClaudeProvider();
        window.providerUtils.registerProvider(providerInstance.name, providerInstance.supportedDomains, providerInstance);
        console.log("ClaudeProvider: Registered successfully.");
    } else {
        console.log("ClaudeProvider: Waiting for providerUtils...");
        setTimeout(register, 500);
    }
})();
