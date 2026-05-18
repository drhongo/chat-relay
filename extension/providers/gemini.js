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
// AI Chat Relay - Gemini Provider

class GeminiProvider {
  constructor() {
    this.name = 'GeminiProvider';
    this.supportedDomains = ['gemini.google.com'];

    // --- START OF CONFIGURABLE PROPERTIES ---
    this.captureMethod = "dom"; // Reverting to DOM as primary for stability
    this.debuggerUrlPattern = "*://gemini.google.com/*";
    this.includeThinkingInMessage = false;
    // --- END OF CONFIGURABLE PROPERTIES ---

    // Selectors for the Gemini interface
    this.inputSelector = 'div.ql-editor, div[contenteditable="true"], textarea[placeholder="Enter a prompt here"], textarea.message-input';
    this.sendButtonSelector = 'button[aria-label="Send message"], .send-button-container button, .input-area-container button[kind="filled"]';
    this.responseSelector = 'div.markdown.markdown-main-panel, message-content div.markdown, message-content .markdown-renderer, [id^="model-response-message-content"], .model-response-text .markdown';
    this.thinkingIndicatorSelector = '.thinking-indicator, .loading-indicator, .typing-indicator, .response-loading, .blue-circle, .stop-icon, button[aria-label="Stop response"]';
    this.newChatSelector = 'a[href="/app"], .new-chat-button, [data-testid="sidebar-new-chat-button"], button[aria-label="New chat"]';

    this.lastSentMessage = '';
    this.pendingResponseCallbacks = new Map();
    this.requestAccumulators = new Map();
    this.domFallbackTimeout = 12000;
    this.domFallbackTimer = null;
    this.domMonitorTimer = null;

    this._lastInterceptedClipboardText = null;
    this._injectClipboardProxy();
    this._loadSettings();
    console.log(`[${this.name}] Provider initialized.`);
  }

  _injectClipboardProxy() {
      this._lastDOMText = null;
      this._lastDOMIsGenerating = false;

      window.addEventListener('message', (e) => {
          if (!e.data) return;
          if (e.data.type === 'RELAY_CLIPBOARD_CAPTURE') {
              this._lastInterceptedClipboardText = e.data.detail;
              console.log(`[${this.name}] Received intercepted text from proxy.`);
          } else if (e.data.type === 'RELAY_DOM_UPDATE') {
              this._lastDOMText = e.data.text;
              this._lastDOMIsGenerating = e.data.isGenerating;
          }
      });
  }

  _loadSettings() {
    chrome.storage.sync.get({ geminiCaptureMethod: 'dom' }, (items) => {
      this.captureMethod = items.geminiCaptureMethod;
      console.log(`[${this.name}] Capture method updated to: ${this.captureMethod}`);
    });
  }

  // Send a message to the chat interface
  async sendChatMessage(messageContent, messageOrId) {
    const requestId = typeof messageOrId === 'object' ? messageOrId.requestId : messageOrId;
    console.log(`[${this.name}] sendChatMessage called for requestId ${requestId}`);
    const MAX_RETRIES = 5;

    let textToInput = "";
    if (typeof messageContent === 'string') {
      textToInput = messageContent;
    } else if (Array.isArray(messageContent)) {
      textToInput = messageContent.map(p => p.text || "").join("\n");
    }

    try {
      this.lastSentMessage = textToInput;
      this._lastDOMText = null;
      this._lastDOMIsGenerating = true;

      let expectedIndex = 0;
      const isNewChat = typeof messageOrId === 'object' && messageOrId.settings && messageOrId.settings.new_chat;
      if (!isNewChat) {
          const findDeep = (root, selector) => {
              const results = [];
              const search = (node) => {
                  if (!node) return;
                  if (node.matches && node.matches(selector)) {
                      results.push(node);
                  }
                  if (node.querySelectorAll) {
                      const direct = node.querySelectorAll(selector);
                      for (const el of direct) {
                          if (!results.includes(el)) {
                              results.push(el);
                          }
                      }
                  }
                  if (node.shadowRoot) {
                      search(node.shadowRoot);
                  }
                  let child = node.firstElementChild;
                  while (child) {
                      search(child);
                      child = child.nextElementSibling;
                  }
              };
              search(root);
              return results;
          };
          const existingHosts = findDeep(document, 'model-response message-content');
          expectedIndex = existingHosts.length;
      }
      this._currentExpectedIndex = expectedIndex;
      console.log(`[${this.name}] Setting expected response index to ${expectedIndex}`);
      window.postMessage({ type: 'RELAY_SET_EXPECTED_INDEX', index: expectedIndex }, '*');

      // Handle New Chat request
      if (typeof messageOrId === 'object' && messageOrId.settings && messageOrId.settings.new_chat) {
        // Robust check for New Chat - if we are not on the main /app page, or even if we are (to clear draft)
        console.log(`[${this.name}] New Chat requested. Clicking New Chat button.`);
        const newChatButton = document.querySelector(this.newChatSelector);
        if (newChatButton) {
          const rect = newChatButton.getBoundingClientRect();
          const clientX = rect.left + rect.width / 2;
          const clientY = rect.top + rect.height / 2;

          newChatButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', clientX, clientY }));
          newChatButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX, clientY }));
          newChatButton.click();
          newChatButton.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', clientX, clientY }));
          newChatButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX, clientY }));

          await new Promise(resolve => setTimeout(resolve, 3000));
        } else {
          console.warn(`[${this.name}] New Chat button not found, continuing with current chat.`);
        }
      }

      // Find input element (after potential navigation)
      const inputElement = document.querySelector(this.inputSelector);
      if (!inputElement) {
        console.error(`[${this.name}] Missing input field (${this.inputSelector})`);
        this._reportSendError(requestId, "Input field not found.");
        return false;
      }

      inputElement.focus();

      // Use execCommand for contentEditable or fallback to value/innerText
      if (inputElement.getAttribute('contenteditable') === 'true' || inputElement.contentEditable === 'true') {
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        document.execCommand('insertText', false, textToInput);

        if (inputElement.innerText.trim() === "" && textToInput.trim() !== "") {
          inputElement.innerText = textToInput;
        }
      } else {
        inputElement.value = textToInput;
      }

      // Trigger events
      console.log(`[${this.name}] [TRACE-${requestId}] Firing input events to element.`);
      const events = ['input', 'change', 'keyup', 'keydown'];
      events.forEach(type => inputElement.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })));

      console.log(`[${this.name}] [TRACE-${requestId}] Waiting 300ms for state binding...`);
      await new Promise(resolve => setTimeout(resolve, 300));

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const sendButton = document.querySelector(this.sendButtonSelector);
        if (sendButton) {
          const isDisabled = sendButton.disabled ||
            sendButton.getAttribute('aria-disabled') === 'true' ||
            sendButton.classList.contains('disabled');

          console.log(`[${this.name}] [TRACE-${requestId}] Send button found on attempt ${attempt + 1}. Disabled: ${isDisabled}`);

          if (!isDisabled) {
            console.log(`[${this.name}] [TRACE-${requestId}] Clicking send button on attempt ${attempt + 1}`);

            const rect = sendButton.getBoundingClientRect();
            const clientX = rect.left + rect.width / 2;
            const clientY = rect.top + rect.height / 2;

            sendButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', clientX, clientY }));
            sendButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX, clientY }));
            sendButton.click();
            sendButton.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', clientX, clientY }));
            sendButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX, clientY }));

            inputElement.blur();
            
            // Enter key fallback sequence after a tiny delay
            console.log(`[${this.name}] [TRACE-${requestId}] Dispatching Enter key fallback in 100ms...`);
            setTimeout(() => {
              console.log(`[${this.name}] [TRACE-${requestId}] Executing Enter key fallback.`);
              inputElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
              inputElement.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            }, 100);

            console.log(`[${this.name}] [TRACE-${requestId}] sendChatMessage returning true.`);
            return true;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      this._reportSendError(requestId, "Failed to clear input after all attempts.");
      return false;
    } catch (error) {
      console.error(`[${this.name}] Error in sendChatMessage:`, error);
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

  async _startDOMMonitoring(requestId) {
    const startTime = Date.now();
    console.log(`[${this.name}] [TRACE-${requestId}] Starting DOM monitoring. Timestamp: ${startTime}ms`);
    let lastCapturedText = "";
    let noChangeStreak = 0;
    let checkCount = 0;
    
    // Small initial delay to allow Gemini UI to show the "Stop" button or generating indicator
    await new Promise(resolve => setTimeout(resolve, 500));

    const monitor = async () => {
      checkCount++;
      const now = Date.now();
      const elapsed = now - startTime;
      const callback = this.pendingResponseCallbacks.get(requestId);
      if (!callback) {
        console.log(`[${this.name}] [TRACE-${requestId}] No callback found, stopping monitor at tick ${checkCount}. Elapsed: ${elapsed}ms`);
        this._stopDOMMonitoring();
        return;
      }
      
      const captureResult = this.captureResponse();
      const currentText = captureResult.text;
      const isStillGenerating = captureResult.isStillGenerating;
      let isFinalDOMResponse = false;
      
      if (currentText && currentText !== lastCapturedText) {
        console.log(`[${this.name}] [TRACE-${requestId}] Text updated (len: ${currentText.length}) at tick ${checkCount}. Elapsed: ${elapsed}ms`);
        lastCapturedText = currentText;
        noChangeStreak = 0;
      } else if (currentText === lastCapturedText) {
        noChangeStreak++;
        if (currentText.trim() !== "") {
          console.log(`[${this.name}] [TRACE-${requestId}] Text unchanged at tick ${checkCount}. Streak: ${noChangeStreak}. Elapsed: ${elapsed}ms`);
        }
      }

      // Only mark final if we are NOT generating AND we have a stable response
      if (!isStillGenerating && noChangeStreak >= 2 && lastCapturedText.trim() !== "") {
        console.log(`[${this.name}] [TRACE-${requestId}] Done: generating stopped, stable streak reached. Elapsed: ${elapsed}ms`);
        isFinalDOMResponse = true;
      }

      // STABLE-TEXT FALLBACK: If text is unchanged for 1.0s (4 checks) and non-empty, finalize instantly
      if (noChangeStreak >= 4 && lastCapturedText.trim() !== "") {
        console.log(`[${this.name}] [TRACE-${requestId}] Done: stable-text fallback triggered (1.0s no change). Elapsed: ${elapsed}ms`);
        isFinalDOMResponse = true;
      }

      if (!isStillGenerating && noChangeStreak >= 40 && lastCapturedText.trim() === "" && checkCount > 40) {
        console.log(`[${this.name}] [TRACE-${requestId}] Done: empty timeout reached. Elapsed: ${elapsed}ms`);
        isFinalDOMResponse = true;
      }
      
      if (checkCount > 120) {
        console.log(`[${this.name}] [TRACE-${requestId}] Done: hard timeout (30s) reached. Elapsed: ${elapsed}ms`);
        isFinalDOMResponse = true;
      }

      if (isFinalDOMResponse) {
        console.log(`[${this.name}] [TRACE-${requestId}] Finalizing. Elapsed: ${now - startTime}ms. Attempting copy button capture...`);

        // OPTIMIZATION: Try to get perfect text from Copy button
        const copyStartTime = Date.now();
        const perfectText = await this._captureFromCopyButton(this._currentExpectedIndex);
        console.log(`[${this.name}] [TRACE-${requestId}] Copy button capture finished. Took: ${Date.now() - copyStartTime}ms. Success: ${!!perfectText}`);
        
        if (perfectText) {
            lastCapturedText = perfectText;
        }

        const cleanedText = this._cleanResponse(lastCapturedText || "");
        if (cleanedText.trim() === "") {
            callback(requestId, "[Empty response captured - possibly an image or widget without text]", true);
        } else {
            callback(requestId, cleanedText, true);
        }
        this.pendingResponseCallbacks.delete(requestId);
        this._stopDOMMonitoring();
      } else {
        this.domMonitorTimer = setTimeout(monitor, 250);
      }
    };
    monitor();
  }

  async _captureFromCopyButton(expectedIndex) {
    console.log(`[${this.name}] Attempting to capture from Copy button via event interception. Expected index: ${expectedIndex}`);
    return new Promise(async (resolve) => {
        let capturedText = null;
        
        // Listener to intercept the copy event
        const onCopy = (e) => {
            const text = e.clipboardData.getData('text/plain');
            if (text && text.trim().length > 0) {
                console.log(`[${this.name}] Successfully intercepted copy event! Text length: ${text.length}`);
                capturedText = text.trim();

                // Block the copy from hitting the system clipboard and stop UI popups
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        };

        try {
            document.addEventListener('copy', onCopy, true);

            // Helper to recursively pierce all Shadow DOMs and find matching elements
            const findDeep = (root, selector) => {
                const results = [];
                const search = (node) => {
                    if (!node) return;
                    if (node.matches && node.matches(selector)) {
                        results.push(node);
                    }
                    if (node.querySelectorAll) {
                        const direct = node.querySelectorAll(selector);
                        for (const el of direct) {
                            if (!results.includes(el)) {
                                results.push(el);
                            }
                        }
                    }
                    if (node.shadowRoot) {
                        search(node.shadowRoot);
                    }
                    let child = node.firstElementChild;
                    while (child) {
                        search(child);
                        child = child.nextElementSibling;
                    }
                };
                search(root);
                return results;
            };

            const getActiveCopyButton = () => {
                const hosts = findDeep(document, 'model-response message-content');
                if (expectedIndex === null || expectedIndex === undefined || expectedIndex >= hosts.length) {
                    return null;
                }
                const activeHost = hosts[expectedIndex];
                let container = activeHost.closest('model-response, [role="article"], .model-response');
                if (!container) {
                    container = activeHost.parentElement || activeHost;
                }
                
                // Find all potential copy buttons inside the container
                const btns = findDeep(container, 'button[data-test-id="copy-button"], button[data-testid="copy-button"], button[aria-label="Copy"], button[aria-label*="Copy" i], [data-test-id*="copy" i], [data-testid*="copy" i]');
                
                // Filter to find the main copy button (prefer exact aria-label="Copy" or data-test-id, exclude code copy)
                const mainBtn = btns.find(btn => {
                    const label = (btn.getAttribute('aria-label') || "").trim().toLowerCase();
                    return label === 'copy' || btn.getAttribute('data-test-id') === 'copy-button' || btn.getAttribute('data-testid') === 'copy-button';
                });
                
                return mainBtn || btns[0] || null;
            };

            // Wait for the copy button of our expected active turn to appear in the DOM
            let targetButton = getActiveCopyButton();
            let waitTime = 0;
            const checkInterval = 50;
            const maxWait = 2000;

            if (expectedIndex !== null && expectedIndex !== undefined) {
                console.log(`[${this.name}] [TRACE-COPY] Waiting for active copy button to appear for expectedIndex: ${expectedIndex}`);
                while (!targetButton && waitTime < maxWait) {
                    await new Promise(r => setTimeout(r, checkInterval));
                    waitTime += checkInterval;
                    targetButton = getActiveCopyButton();
                }
                console.log(`[${this.name}] [TRACE-COPY] Finished waiting for active copy button. Found: ${!!targetButton}, waited: ${waitTime}ms`);
            }

            if (!targetButton) {
                console.log(`[${this.name}] [TRACE-COPY] Target copy button not found, aborting copy capture.`);
                document.removeEventListener('copy', onCopy, true);
                return resolve(null);
            }

            // CRITICAL: Reset clipboard interception text BEFORE clicking, because the click event
            // executes fully synchronously and populates the text synchronously!
            this._lastInterceptedClipboardText = null;

            console.log(`[${this.name}] [TRACE-COPY] Scrolling to and clicking copy button:`, targetButton);
            targetButton.scrollIntoView({ block: 'center' });
            
            // Programmatic click
            targetButton.click();
            
            // Wait up to 1.5s for the copy event
            let clipboardWaitTime = 0;

            const waitLoop = setInterval(() => {
                clipboardWaitTime += checkInterval;
                const foundText = capturedText || this._lastInterceptedClipboardText;
                if (foundText) {
                    console.log(`[${this.name}] [TRACE-COPY] Captured text successfully from clipboard after ${clipboardWaitTime}ms! Text len: ${foundText.length}`);
                    clearInterval(waitLoop);
                    document.removeEventListener('copy', onCopy, true);
                    resolve(foundText);
                } else if (clipboardWaitTime >= maxWait) {
                    console.log(`[${this.name}] [TRACE-COPY] Timeout waiting for copy event (${maxWait}ms reached).`);
                    clearInterval(waitLoop);
                    document.removeEventListener('copy', onCopy, true);
                    resolve(null);
                }
            }, checkInterval);

        } catch (err) {
            console.error(`[${this.name}] Error in copy interception:`, err);
            document.removeEventListener('copy', onCopy, true);
            resolve(null);
        }
    });
  }

  async _readClipboard() {
    return null; // Redirect to interception
  }

  _stopDOMMonitoring() {
    if (this.domMonitorTimer) {
      clearTimeout(this.domMonitorTimer);
      this.domMonitorTimer = null;
    }
  }

  // Standard method name used by content.js - with Shadow DOM piercing
  captureResponse() {
    console.log(`[${this.name}] captureResponse ENTER`);

    // Helper to recursively pierce all Shadow DOMs and find matching elements
    const findDeep = (root, selector) => {
      const results = [];
      const search = (node) => {
        if (!node) return;
        
        // Match current node
        if (node.matches && node.matches(selector)) {
          results.push(node);
        }
        
        // Also query direct descendants if matches isn't enough, or to collect sub-elements
        if (node.querySelectorAll) {
          const direct = node.querySelectorAll(selector);
          for (const el of direct) {
            if (!results.includes(el)) {
              results.push(el);
            }
          }
        }
        
        // Pierce Shadow Root if present
        if (node.shadowRoot) {
          search(node.shadowRoot);
        }
        
        // Traverse standard children
        let child = node.firstElementChild;
        while (child) {
          search(child);
          child = child.nextElementSibling;
        }
      };
      
      search(root);
      return results;
    };

    // Safeguard: Ensure the target turn's message-content host has actually been created in the DOM
    const hosts = findDeep(document, 'model-response message-content');
    if (this._currentExpectedIndex === null || this._currentExpectedIndex === undefined || hosts.length <= this._currentExpectedIndex) {
      console.log(`[${this.name}] [TRACE-SAFEGUARD] Expected host at index ${this._currentExpectedIndex} not created yet (hosts count: ${hosts.length}). Returning empty pending state.`);
      return {
        found: false,
        text: "",
        isStillGenerating: true,
        isDefinitelyFinal: false
      };
    }

    if (this._lastDOMText !== null) {
      console.log(`[${this.name}] Using real-time main world DOM text (len: ${this._lastDOMText.length}, generating: ${this._lastDOMIsGenerating}).`);
      return {
        found: this._lastDOMText.length > 0,
        text: this._lastDOMText,
        isStillGenerating: this._lastDOMIsGenerating,
        isDefinitelyFinal: !this._lastDOMIsGenerating && this._lastDOMText.length > 0
      };
    }

    // Try primary and fallback selectors with shadow piercing
    let responseElements = findDeep(document, this.responseSelector);

    // If we have an expected index, ONLY look at elements inside that expected host!
    if (this._currentExpectedIndex !== null && this._currentExpectedIndex !== undefined) {
        if (hosts.length > this._currentExpectedIndex) {
            const activeHost = hosts[this._currentExpectedIndex];
            // Filter responseElements to ONLY those that are descendants of activeHost
            responseElements = responseElements.filter(el => activeHost.contains(el) || activeHost === el);
            if (responseElements.length === 0) {
                // If the host exists but has no markdown elements yet, just use the host itself
                responseElements = [activeHost];
            }
        }
    }
    // Filter out elements that are likely part of the "Welcome/Home" screen chips or sidebar
    const isExcluded = (el) => {
      const text = el.innerText || "";
      // Gemini welcome screen often contains these strings
      if (text.includes("Create image") || text.includes("Help me learn") || text.includes("Boost my day") || text.includes("Create music")) {
        return true;
      }
      // Exclude sidebar/history items specifically
      if (el.closest('nav, [role="navigation"], .sidebar, .chat-history, [id*="history"]')) {
        return true;
      }
      return false;
    };

    const isVisible = (el) => {
      try {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        
        // Log dimensions - elements with display: contents are fully visible but have no layout box/size.
        if (rect.width === 0 && rect.height === 0 && style.display !== 'contents') {
          console.log(`[${this.name}] isVisible [REJECTED-dimensions]: el has 0x0 size for tag: ${el.tagName}`);
          return false;
        }
        
        if (style.display === 'none' || style.visibility === 'hidden') {
          console.log(`[${this.name}] isVisible [REJECTED-style]: display=${style.display}, visibility=${style.visibility} for tag: ${el.tagName}`);
          return false;
        }
        
        // Traverse parents safely, piercing Shadow DOM boundaries
        let parent = el.parentElement || (el.parentNode && el.parentNode.host);
        while (parent) {
            // ShadowRoot is a DocumentFragment, skip it and go to its host
            if (parent instanceof DocumentFragment) {
                parent = parent.host;
                continue;
            }
            if (parent.nodeType !== Node.ELEMENT_NODE) {
                parent = parent.parentElement || (parent.parentNode && parent.parentNode.host);
                continue;
            }
            
            const parentStyle = window.getComputedStyle(parent);
            if (parentStyle.display === 'none' || parentStyle.visibility === 'hidden') {
                console.log(`[${this.name}] isVisible [REJECTED-parent]: hidden parent ${parent.tagName}`);
                return false;
            }
            parent = parent.parentElement || (parent.parentNode && parent.parentNode.host);
        }
        
        return true;
      } catch (err) {
        console.error(`[${this.name}] isVisible CRASHED:`, err.message, err.stack);
        return false;
      }
    };

    console.log(`[${this.name}] Raw findDeep search matched ${responseElements.length} elements before filtering.`);

    responseElements = responseElements.filter(el => !isExcluded(el) && isVisible(el));

    console.log(`[${this.name}] Primary search found ${responseElements.length} visible elements.`);

    if (responseElements.length === 0) {
      responseElements = findDeep(document, 'message-content, .model-response-text, .markdown-renderer, .markdown, .response-container');
      console.log(`[${this.name}] Raw fallback findDeep matched ${responseElements.length} elements.`);
      responseElements = responseElements.filter(el => !isExcluded(el) && isVisible(el));
      console.log(`[${this.name}] Fallback search found ${responseElements.length} visible elements.`);
    }

    const lastResponse = responseElements[responseElements.length - 1];
    let text = lastResponse ? (lastResponse.innerText || lastResponse.textContent || "").trim() : "";

    // CLEANUP: Strip Gemini UI noise
    text = this._cleanResponse(text);

    // Safety check: if text exactly matches the prompt, it might be the user message echoing back
    if (this.lastSentMessage && text === this.lastSentMessage.trim()) {
      console.log(`[${this.name}] Extracted text matches last sent message. Skipping.`);
      text = "";
    }

    console.log(`[${this.name}] Extracted text length: ${text.length}. Sample: "${text.substring(0, 50)}..."`);

    // Check for thinking indicator
    const thinkingNodes = [
      ...findDeep(document, this.thinkingIndicatorSelector),
      ...findDeep(document, '.blue-circle'),
      ...findDeep(document, '.typing-indicator'),
      ...findDeep(document, 'button[aria-label="Stop response"]')
    ];

    const isStillGenerating = thinkingNodes.some(node => {
      if (!node) return false;
      // Check if visible
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && node.offsetParent !== null;
    });

    console.log(`[${this.name}] isStillGenerating: ${isStillGenerating} (Found ${thinkingNodes.length} indicator nodes)`);

    const result = {
      found: text.length > 0,
      text,
      isStillGenerating,
      elementCount: responseElements.length
    };

    window.CHAT_RELAY_DEBUG = { lastResult: result, timestamp: new Date().toISOString() };
    return result;
  }

  // Helper to strip Gemini's UI-specific labels and boilerplate
  _cleanResponse(text) {
    if (!text) return "";
    
    // Gemini "Copy" button boilerplate removal
    // It often starts with "Conversation with Gemini\nYou said\n...\nGemini said\n"
    if (text.includes("Gemini said")) {
        const parts = text.split("Gemini said");
        // Take the part after the last "Gemini said" to get the latest response
        text = parts[parts.length - 1];
    }
    
    // Remove footer noise if present
    const footerMarkers = ["Tools\nFast", "Gemini is AI and can make mistakes"];
    for (const marker of footerMarkers) {
        if (text.includes(marker)) {
            text = text.split(marker)[0];
        }
    }

    return text.trim();
  }

  getResponseText(element) {
    if (!element) return "";
    return element.innerText || element.textContent || "";
  }

  isResponseComplete(element) {
    const result = this.captureResponse();
    return !result.isStillGenerating;
  }

  async initiateResponseCapture(requestId, responseCallback) {
    console.log(`[${this.name}] initiateResponseCapture called for requestId: ${requestId}. Capture method: ${this.captureMethod}`);
    this.pendingResponseCallbacks.set(requestId, responseCallback);

    // Reset accumulator for this request
    this.requestAccumulators.set(requestId, { text: "", isDefinitelyFinal: false });

    // Reset expected index and telemetry variables to isolate new request
    this._currentExpectedIndex = null;
    this._lastDOMText = null;
    this._lastDOMIsGenerating = true;

    if (this.captureMethod === "debugger") {
      console.log(`[${this.name}] Debugger capture initiated. Requesting debugger attachment.`);

      const patterns = this.getStreamingApiPatterns();
      await new Promise(resolve => {
        chrome.runtime.sendMessage({
          type: "SET_DEBUGGER_TARGETS",
          providerName: this.name,
          patterns: patterns
        }, response => {
          console.log(`[${this.name}] SET_DEBUGGER_TARGETS response:`, response);
          resolve();
        });
      });

      // Clear any existing fallback timer
      if (this.domFallbackTimer) clearTimeout(this.domFallbackTimer);

      this.domFallbackTimer = setTimeout(() => {
        const acc = this.requestAccumulators.get(requestId);
        if (acc && acc.text.length === 0) {
          console.warn(`[${this.name}] No data received via debugger after ${this.domFallbackTimeout}ms. Falling back to DOM capture.`);
          this._startDOMMonitoring(requestId);
        }
      }, this.domFallbackTimeout);
    } else {
      this._startDOMMonitoring(requestId);
    }
  }

  handleDebuggerData(requestId, rawData, isFinalFromBackground) {
    const callback = this.pendingResponseCallbacks.get(requestId);
    if (!callback) return;

    let accumulator = this.requestAccumulators.get(requestId);
    if (!accumulator) {
      accumulator = { text: "", isDefinitelyFinal: false };
      this.requestAccumulators.set(requestId, accumulator);
    }

    if (accumulator.isDefinitelyFinal) return;

    if (rawData && rawData.trim() !== "") {
      const parseOutput = this.parseDebuggerResponse(rawData);

      if (accumulator.text.length === 0 && parseOutput.text) {
        console.log(`[${this.name}] First debugger data received for ${requestId}. Disabling DOM fallback timer.`);
        if (this.domFallbackTimer) {
          clearTimeout(this.domFallbackTimer);
          this.domFallbackTimer = null;
        }
      }

      if (parseOutput.text !== null) {
        accumulator.text = parseOutput.text;
      }

      if (parseOutput.isFinalResponse) {
        accumulator.isDefinitelyFinal = true;
      }

      if (parseOutput.text !== null || accumulator.isDefinitelyFinal) {
        callback(requestId, accumulator.text, accumulator.isDefinitelyFinal);
      }
    } else if (isFinalFromBackground && !accumulator.isDefinitelyFinal) {
      accumulator.isDefinitelyFinal = true;
      callback(requestId, accumulator.text, true);
    }

    if (accumulator.isDefinitelyFinal) {
      this.pendingResponseCallbacks.delete(requestId);
      this.requestAccumulators.delete(requestId);
    }
  }

  parseDebuggerResponse(rawDataString) {
    let text = null;
    let isFinalResponse = false;

    if (!rawDataString) return { text, isFinalResponse };

    try {
      // Gemini often returns chunks that are arrays like [["something", ...]]
      // or multiple such arrays separated by newlines or numbers (length prefixes).

      // Strategy: find all JSON-like array structures and extract the longest string
      // which is almost always the actual response content.

      const chunks = rawDataString.split("\n");
      let bestText = "";

      for (const chunk of chunks) {
        if (!chunk.trim()) continue;

        // Try to find array patterns
        const matches = chunk.match(/\[[\s\S]*\]/g);
        if (matches) {
          for (const match of matches) {
            try {
              const parsed = JSON.parse(match);
              // Recursively search for the longest string in the parsed object
              const findLongestString = (obj) => {
                let longest = "";
                if (typeof obj === 'string') return obj;
                if (Array.isArray(obj)) {
                  obj.forEach(item => {
                    const s = findLongestString(item);
                    if (s.length > longest.length) longest = s;
                  });
                } else if (typeof obj === 'object' && obj !== null) {
                  Object.values(obj).forEach(val => {
                    const s = findLongestString(val);
                    if (s.length > longest.length) longest = s;
                  });
                }
                return longest;
              };

              const candidate = findLongestString(parsed);
              if (candidate.length > bestText.length) {
                bestText = candidate;
              }
            } catch (e) {
              // Not valid JSON array, skip
            }
          }
        }
      }

      if (bestText.length > 0) {
        text = bestText;
      }

      // Gemini completion indicators
      if (rawDataString.includes("xsrf_token") || rawDataString.includes("finish_reason")) {
        // isFinalResponse = true;
      }
    } catch (e) {
      console.warn(`[${this.name}] Error parsing debugger response:`, e);
    }

    return { text, isFinalResponse };
  }

  getStreamingApiPatterns() {
    return [
      { urlPattern: "*://gemini.google.com/_/BardChatUi/data/assistant.v1.BardAssistant/StreamGenerate*", requestStage: "Response" },
      { urlPattern: "*://gemini.google.com/app/v1/chat*", requestStage: "Response" }
    ];
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

  findResponseElement(container) {
    return container.querySelector ? container.querySelector(this.responseSelector) : null;
  }

  shouldSkipResponseMonitoring() {
    return false; // We WANT DOM monitoring
  }
}

// Robust registration
(function register() {
  if (window.providerUtils) {
    console.log("GeminiProvider: Registering...");
    const providerInstance = new GeminiProvider();
    window.providerUtils.registerProvider(providerInstance.name, providerInstance.supportedDomains, providerInstance);
    console.log("GeminiProvider: Registered successfully.");
  } else {
    console.log("GeminiProvider: Waiting for providerUtils...");
    setTimeout(register, 500);
  }
})();