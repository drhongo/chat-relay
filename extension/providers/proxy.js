(function() {
    try {
        const originalClipboard = navigator.clipboard;
        
        // Create our custom proxy clipboard object
        const proxyClipboard = {
            writeText: async function(text) {
                console.log('[Relay Proxy] Intercepted clipboard writeText:', text.substring(0, 50) + '...');
                window.postMessage({ type: 'RELAY_CLIPBOARD_CAPTURE', detail: text }, '*');
                // Return a resolved promise to satisfy the site's async call and prevent "Failed to copy" popups
                return Promise.resolve();
            },
            write: async function(data) {
                console.log('[Relay Proxy] Intercepted clipboard write (ClipboardItem array):', data);
                let plainText = "";
                
                if (Array.isArray(data)) {
                    for (const item of data) {
                        if (item && item.types && item.types.includes('text/plain')) {
                            try {
                                const blob = await item.getType('text/plain');
                                plainText = await blob.text();
                                console.log('[Relay Proxy] Extracted plain text from ClipboardItem:', plainText.substring(0, 50) + '...');
                                break; // Take first plain text type
                            } catch (err) {
                                console.error('[Relay Proxy] Failed to extract text from ClipboardItem:', err);
                            }
                        }
                    }
                }

                if (plainText) {
                    window.postMessage({ type: 'RELAY_CLIPBOARD_CAPTURE', detail: plainText }, '*');
                }
                
                // Return success to satisfy the site and prevent "Failed to copy" popups
                return Promise.resolve();
            }
        };

        // Forward other native clipboard methods to preserve standard functionality (excluding write/writeText)
        if (originalClipboard) {
            const methods = ['readText', 'read', 'addEventListener', 'removeEventListener', 'dispatchEvent'];
            methods.forEach(method => {
                if (typeof originalClipboard[method] === 'function') {
                    proxyClipboard[method] = originalClipboard[method].bind(originalClipboard);
                }
            });
        }

        // Resiliently override navigator.clipboard using Object.defineProperty
        Object.defineProperty(navigator, 'clipboard', {
            value: proxyClipboard,
            writable: true,
            configurable: true
        });

        console.log('[Relay Proxy] Resilient Clipboard & Rich-Write proxy successfully initialized.');

        // --- GEMINI MAIN-WORLD SHADOW DOM TELEMETRY STREAM ---
        if (window.location.hostname === 'gemini.google.com') {
            console.log('[Relay Proxy] Initializing Gemini Main-World Shadow DOM Telemetry...');

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

            const isExcluded = (el) => {
                const text = el.innerText || "";
                if (text.includes("Create image") || text.includes("Help me learn") || text.includes("Boost my day") || text.includes("Create music")) {
                    return true;
                }
                return false;
            };

            const isVisible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                if (rect.width === 0 && rect.height === 0 && style.display !== 'contents') return false;
                if (style.display === 'none' || style.visibility === 'hidden') return false;
                
                let parent = el.parentElement || (el.parentNode && el.parentNode.host);
                while (parent) {
                    if (parent instanceof DocumentFragment) {
                        parent = parent.host;
                        continue;
                    }
                    if (parent.nodeType !== Node.ELEMENT_NODE) {
                        parent = parent.parentElement || (parent.parentNode && parent.parentNode.host);
                        continue;
                    }
                    const parentStyle = window.getComputedStyle(parent);
                    if (parentStyle.display === 'none' || parentStyle.visibility === 'hidden') return false;
                    parent = parent.parentElement || (parent.parentNode && parent.parentNode.host);
                }
                return true;
            };

            let expectedResponseIndex = null;
            let lastBroadcastText = "";
            let lastBroadcastIsGenerating = false;

            window.addEventListener('message', (e) => {
                if (e.data && e.data.type === 'RELAY_SET_EXPECTED_INDEX') {
                    expectedResponseIndex = e.data.index;
                    console.log('[Relay Proxy] Set expected response index to:', expectedResponseIndex);
                }
            });

            setInterval(() => {
                try {
                    let text = "";
                    let isGenerating = false;

                    const thinkingSelector = '.thinking-indicator, .loading-indicator, .typing-indicator, .response-loading, .blue-circle, .stop-icon, button[aria-label="Stop response"], button[aria-label="Stop generating"], button[aria-label*="Stop"], mat-icon[fonticon="stop"], mat-icon[data-mat-icon-name="stop"], .send-button mat-icon[fonticon="stop"]';
                    const thinkingNodes = findDeep(document, thinkingSelector);
                    isGenerating = thinkingNodes.length > 0;

                    if (expectedResponseIndex !== null) {
                        const hosts = findDeep(document, 'model-response message-content');
                        if (hosts.length <= expectedResponseIndex) {
                            // The new response has not even been created yet!
                            text = "";
                            isGenerating = true; // Still generating by definition
                        } else {
                            const activeHost = hosts[expectedResponseIndex];
                            
                            // Find the leaf markdown element inside this specific host
                            const leafSelector = '.markdown-renderer, div.markdown, .markdown, .model-response-text';
                            const leaves = findDeep(activeHost, leafSelector);
                            const activeLeaf = leaves[leaves.length - 1] || activeHost;
                            
                            text = (activeLeaf.innerText || activeLeaf.textContent || "").trim();
                        }
                    } else {
                        // Fallback for manual typing or un-indexed starts
                        const responseSelector = 'message-content .markdown-renderer, div.markdown.markdown-main-panel, message-content div.markdown, [id^="model-response-message-content"], .model-response-text .markdown';
                        const responseElements = findDeep(document, responseSelector);
                        const visible = responseElements.filter(el => !isExcluded(el) && isVisible(el));
                        
                        const lastResponse = visible[visible.length - 1];
                        text = lastResponse ? (lastResponse.innerText || lastResponse.textContent || "").trim() : "";
                    }

                    // Clean up UI action icons from innerText if present (same as gemini.js _cleanResponse logic)
                    if (text) {
                        // Strip trailing share/export action noise
                        text = text.replace(/share\n?$/i, '').trim();
                        text = text.replace(/more_vert\n?$/i, '').trim();
                        text = text.replace(/thumb_up\n?$/i, '').trim();
                        text = text.replace(/thumb_down\n?$/i, '').trim();
                    }

                    if (text !== lastBroadcastText || isGenerating !== lastBroadcastIsGenerating) {
                        lastBroadcastText = text;
                        lastBroadcastIsGenerating = isGenerating;
                        
                        window.postMessage({ 
                            type: 'RELAY_DOM_UPDATE', 
                            text: text, 
                            isGenerating: isGenerating 
                        }, '*');
                    }
                } catch (err) {
                    // Fail silently to prevent console spam
                }
            }, 100);
        }
    } catch (err) {
        console.error('[Relay Proxy] Failed to inject clipboard proxy:', err);
    }
})();
