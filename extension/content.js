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
// AI Chat Relay - Content Script

// Prefix for console logs
const CS_LOG_PREFIX = '[CS CONTENT]';
console.log(CS_LOG_PREFIX, "Content Script Injected & Loaded");

// Helper to send logs to background script for remote logging
function logRemote(level, message, requestId = null) {
    chrome.runtime.sendMessage({
        type: "LOG_MESSAGE",
        level: level,
        message: `${CS_LOG_PREFIX} ${message}`,
        requestId: requestId || currentRequestId
    });
    // Also log locally
    if (level === 'error') console.error(CS_LOG_PREFIX, message);
    else if (level === 'warn') console.warn(CS_LOG_PREFIX, message);
    else console.log(CS_LOG_PREFIX, message);
}

// Global state
let provider = null; // This will be set by initializeContentRelay
let setupComplete = false;
let currentRequestId = null;
let processingMessage = false; // Flag to track if we're currently processing a message
let responseMonitoringTimers = []; // Keep track of all monitoring timers
let captureAttempts = 0; // Track how many capture attempts we've made
const MAX_CAPTURE_ATTEMPTS = 30; // Maximum number of capture attempts
const CAPTURE_DELAY = 1000; // 1 second between capture attempts
let isFirstInitialization = true;

// Helper function to find potential input fields and buttons
function findPotentialSelectors() {
  console.log(CS_LOG_PREFIX, "Searching for potential input fields and buttons...");
  
  // Find all textareas
  const textareas = document.querySelectorAll('textarea');
  console.log(CS_LOG_PREFIX, "Found textareas:", textareas.length);
  textareas.forEach((textarea, index) => {
    console.log(CS_LOG_PREFIX, `Textarea ${index}:`, {
      id: textarea.id,
      className: textarea.className,
      ariaLabel: textarea.getAttribute('aria-label'),
      placeholder: textarea.getAttribute('placeholder'),
      name: textarea.name
    });
  });
  
  // Find all input fields
  const inputs = document.querySelectorAll('input[type="text"]');
  console.log(CS_LOG_PREFIX, "Found text inputs:", inputs.length);
  inputs.forEach((input, index) => {
    console.log(CS_LOG_PREFIX, `Input ${index}:`, {
      id: input.id,
      className: input.className,
      ariaLabel: input.getAttribute('aria-label'),
      placeholder: input.getAttribute('placeholder'),
      name: input.name
    });
  });
  
  // Find all buttons
  const buttons = document.querySelectorAll('button');
  console.log(CS_LOG_PREFIX, "Found buttons:", buttons.length);
  buttons.forEach((button, index) => {
    console.log(CS_LOG_PREFIX, `Button ${index}:`, {
      id: button.id,
      className: button.className,
      ariaLabel: button.getAttribute('aria-label'),
      textContent: button.textContent.trim()
    });
  });
}

function initializeContentRelay() {
    // This function can be called multiple times if a provider registers late.
    // We no longer use setupComplete to block re-entry.
    console.log(CS_LOG_PREFIX, 'Initializing content relay...');

    // Provider Detection
    console.log(CS_LOG_PREFIX, 'Checking for window.providerUtils...');
    console.log(CS_LOG_PREFIX, 'window.providerUtils exists:', !!window.providerUtils);
    
    if (window.providerUtils) {
        console.log(CS_LOG_PREFIX, 'Calling detectProvider with hostname:', window.location.hostname);
        const detectedProvider = window.providerUtils.detectProvider(window.location.hostname); // New detection method
        provider = detectedProvider; // Update the global provider instance

        if (provider) {
            console.log(CS_LOG_PREFIX, 'Detected provider:', provider.name);
            console.log(CS_LOG_PREFIX, 'Provider details:', {
                name: provider.name,
                supportedDomains: provider.supportedDomains,
                captureMethod: provider.captureMethod
            });

            // Pattern setup logic only runs if a provider is found
            if (typeof provider.getStreamingApiPatterns === 'function' && provider.captureMethod === 'debugger') {
                const patternsFromProvider = provider.getStreamingApiPatterns();
                console.log(CS_LOG_PREFIX, 'Retrieved patterns from provider:', patternsFromProvider);

                if (patternsFromProvider && patternsFromProvider.length > 0) {
                    chrome.runtime.sendMessage({
                        type: "SET_DEBUGGER_TARGETS",
                        providerName: provider.name,
                        patterns: patternsFromProvider
                    }, response => {
                        if (chrome.runtime.lastError) {
                            console.error(CS_LOG_PREFIX, 'Error sending SET_DEBUGGER_TARGETS:', chrome.runtime.lastError.message);
                        } else {
                            console.log(CS_LOG_PREFIX, 'SET_DEBUGGER_TARGETS message sent, response:', response);
                        }
                    });
                } else {
                    console.log(CS_LOG_PREFIX, 'No patterns returned by provider or patterns array is empty.');
                }
            } else {
                if (typeof provider.getStreamingApiPatterns !== 'function') {
                    console.warn(CS_LOG_PREFIX, `Provider '${provider.name}' is missing the getStreamingApiPatterns method.`);
                } else if (provider.captureMethod !== 'debugger') {
                    console.log(CS_LOG_PREFIX, `Provider '${provider.name}' is using capture method '${provider.captureMethod}', not 'debugger'. Skipping debugger pattern setup.`);
                }
            }
        } else {
            if (isFirstInitialization) {
                console.log(CS_LOG_PREFIX, 'Initial check: No provider registered. Waiting for provider to register...');
            } else {
                console.warn(CS_LOG_PREFIX, 'Provider not detected on re-initialization.');
            }
        }
    } else {
        console.error(CS_LOG_PREFIX, 'providerUtils not found. Cannot detect provider or send patterns.');
    }

    // Send CHAT_RELAY_READY (always, after attempting provider setup)
    chrome.runtime.sendMessage({
      type: "CHAT_RELAY_READY",
      chatInterface: provider ? provider.name : "unknown" // Add provider name
    }, response => {
        if (chrome.runtime.lastError) {
            console.error(CS_LOG_PREFIX, 'Error sending CHAT_RELAY_READY:', chrome.runtime.lastError.message);
        } else {
            console.log(CS_LOG_PREFIX, 'CHAT_RELAY_READY message sent, response:', response);
        }
    });
    
    // Setup message listeners (will be called later, once, via setupMessageListeners)

    // If a provider is detected, proceed with provider-specific setup
    if (provider) {
        console.log(CS_LOG_PREFIX, `Proceeding with provider-specific setup for: ${provider.name}`);
        
        // Use a provider-specific setup flag to ensure we only do this once per provider instance
        if (!provider._chatRelaySetupInitiated) {
            provider._chatRelaySetupInitiated = true;
            
            // Critical setup that can happen immediately (like attaching debugger)
            findPotentialSelectors(); 

            // Setup that might benefit from page being more "ready"
            setTimeout(() => {
                setupAutomaticResponseCapture(); 
                startElementPolling(); 
                console.log(CS_LOG_PREFIX, `Secondary Provider-specific DOM setup for ${provider.name} initiated after delay.`);
            }, 2000); // Delay to allow page elements to fully render
        }
    } else {
        if (isFirstInitialization) {
            console.log(CS_LOG_PREFIX, "No provider detected on initial load. Waiting for provider registration...");
        } else {
            console.warn(CS_LOG_PREFIX, "No provider detected. Some features will not be initialized.");
        }
    }
    
    if (!setupComplete) {
      setupComplete = true;
      console.log(CS_LOG_PREFIX, "Initial content relay setup sequence finished.");
    }
    isFirstInitialization = false;
}

/// Safe querySelector helper that doesn't throw on invalid selectors
function safeQuerySelector(selector) {
    if (!selector) return null;
    try {
        // If it's a comma-separated list, try them one by one to avoid total failure
        const parts = selector.split(',').map(p => p.trim());
        for (const part of parts) {
            try {
                const element = document.querySelector(part);
                if (element) return element;
            } catch (e) {
                // Silently ignore invalid individual selectors
            }
        }
    } catch (e) {
        console.warn(CS_LOG_PREFIX, "Error in safeQuerySelector:", e.message);
    }
    return null;
}

// Poll for elements that might be loaded dynamically
function startElementPolling() {
  if (!provider) return;
  console.log(CS_LOG_PREFIX, "Starting element polling...");
  
  const pollingInterval = setInterval(() => {
    if (!provider) {
        clearInterval(pollingInterval);
        return;
    }
    
    const inputField = safeQuerySelector(provider.inputSelector);
    const sendButton = safeQuerySelector(provider.sendButtonSelector);
    
    if (inputField && sendButton) {
      console.log(CS_LOG_PREFIX, "Found all required elements, stopping polling");
      clearInterval(pollingInterval);
    }
  }, 2000);
}

// Function to send a message to the chat interface
// This is the entry point for messages from the background script
async function handleIncomingChatMessage(messageContent, message) {
  const requestId = typeof message === 'object' ? message.requestId : message;
  if (!provider) {
    console.error(CS_LOG_PREFIX, "Cannot send chat message: No provider configured.");
    return false;
  }
  
  console.log(CS_LOG_PREFIX, `Processing incoming message for requestId: ${requestId}`);
  processingMessage = true;
  currentRequestId = requestId;

  try {
      // Initiate capture BEFORE sending the message to avoid race conditions
      if (provider.initiateResponseCapture) {
          console.log(CS_LOG_PREFIX, `Calling provider.initiateResponseCapture for requestId: ${requestId}`);
          await provider.initiateResponseCapture(requestId, handleProviderResponse);
      }
      const success = await provider.sendChatMessage(messageContent, message);
      if (success) {
          console.log(CS_LOG_PREFIX, `Message sent successfully for requestId: ${requestId}`);

          if (provider.captureMethod !== "debugger" && !provider.initiateResponseCapture) {
              console.log(CS_LOG_PREFIX, `Provider uses ${provider.captureMethod} capture. Starting monitorResponseCompletion.`);
              startMonitoringForResponse();
          }
      } else {
          console.error(CS_LOG_PREFIX, `Provider failed to send message for requestId: ${requestId}`);
          processingMessage = false;
          currentRequestId = null;
      }
      return success;
  } catch (error) {
      console.error(CS_LOG_PREFIX, `Error in handleIncomingChatMessage for requestId: ${requestId}:`, error);
      processingMessage = false;
      currentRequestId = null;
      return false;
  }
}

// Function to start monitoring for a response
function startMonitoringForResponse() {
  if (!provider || !provider.responseSelector || !provider.getResponseText) {
    console.error(CS_LOG_PREFIX, "Cannot monitor for response: Provider or necessary provider methods/selectors are not configured.");
    processingMessage = false; // Can't monitor, so reset.
    return;
  }

  console.log(CS_LOG_PREFIX, "Starting response monitoring process...");
  captureAttempts = 0; // Reset capture attempts for this new monitoring session

  const attemptCapture = () => {
    if (!processingMessage && currentRequestId === null) {
      console.log(CS_LOG_PREFIX, "Response monitoring stopped because processingMessage is false and currentRequestId is null (likely request completed or cancelled).");
      return; // Stop if no longer processing a message
    }
    
    if (captureAttempts >= MAX_CAPTURE_ATTEMPTS) {
      console.error(CS_LOG_PREFIX, "Maximum response capture attempts reached. Stopping monitoring.");
      // Send a timeout/error message back to the background script
      if (currentRequestId !== null) { // Ensure there's a request ID to report error for
          chrome.runtime.sendMessage({
              type: "FINAL_RESPONSE_TO_RELAY",
              requestId: currentRequestId,
              error: "Response capture timed out in content script.",
              isFinal: true // Treat as final to unblock server
          }, response => {
              if (chrome.runtime.lastError) {
                  console.error(CS_LOG_PREFIX, 'Error sending capture timeout error:', chrome.runtime.lastError.message);
              } else {
                  console.log(CS_LOG_PREFIX, 'Capture timeout error sent to background, response:', response);
              }
          });
      }
      processingMessage = false;
      currentRequestId = null; // Clear current request ID as it timed out
      return;
    }

    captureAttempts++;
    console.log(CS_LOG_PREFIX, `Response capture attempt ${captureAttempts}/${MAX_CAPTURE_ATTEMPTS}`);

    let responseText = "";
    let isFinal = false;

    // USE PROVIDER'S CAPTURE METHOD IF AVAILABLE (Important for Shadow DOM support like Gemini)
    if (typeof provider.captureResponse === 'function') {
      const captureResult = provider.captureResponse();
      if (captureResult && captureResult.found) {
        responseText = captureResult.text;
        isFinal = captureResult.isStillGenerating === false;
      }
    } else {
      // Fallback to legacy selection
      const responseElement = document.querySelector(provider.responseSelector);
      if (responseElement) {
        responseText = provider.getResponseText(responseElement);
        isFinal = provider.isResponseComplete ? provider.isResponseComplete(responseElement) : false;
      }
    }

    if (responseText || isFinal) {
      console.log(CS_LOG_PREFIX, `Captured response text (length: ${responseText.length}), isFinal: ${isFinal}`);
      
      // Send to background
      chrome.runtime.sendMessage({
        type: "FINAL_RESPONSE_TO_RELAY", // Or a new type like "PARTIAL_RESPONSE" if needed
        requestId: currentRequestId,
        text: responseText,
        isFinal: isFinal
      }, response => {
          if (chrome.runtime.lastError) {
              console.error(CS_LOG_PREFIX, 'Error sending response data to background:', chrome.runtime.lastError.message);
          } else {
              console.log(CS_LOG_PREFIX, 'Response data sent to background, response:', response);
          }
      });

      if (isFinal) {
        console.log(CS_LOG_PREFIX, "Final response detected. Stopping monitoring.");
        processingMessage = false; // Reset flag as processing is complete
        // currentRequestId will be cleared by handleProviderResponse or if a new message comes
        return; 
      }
    } else {
      console.log(CS_LOG_PREFIX, "Response element not found yet.");
    }

    // Continue polling
    const timer = setTimeout(attemptCapture, CAPTURE_DELAY);
    responseMonitoringTimers.push(timer);
  };

  // Initial call to start the process
  attemptCapture();
}


// Function to set up automatic response capture using MutationObserver
function setupAutomaticResponseCapture() {
  if (!provider) return;
  
  if (!provider.responseContainerSelector || typeof provider.handleMutation !== 'function') {
    if (provider.initiateResponseCapture) {
        // Provider handles its own capture (e.g. ChatGPT with debugger/fallback)
        console.log(CS_LOG_PREFIX, `Provider ${provider.name} handles its own response capture. Skipping standard MutationObserver setup.`);
        return;
    }
    console.warn(CS_LOG_PREFIX, "Cannot set up standard automatic response capture: Provider or necessary provider methods/selectors are not configured.");
    return;
  }

  console.log(CS_LOG_PREFIX, "Setting up MutationObserver for automatic response capture on selector:", provider.responseContainerSelector);

  const targetNode = document.querySelector(provider.responseContainerSelector);

  if (!targetNode) {
    console.warn(CS_LOG_PREFIX, `Response container element ('${provider.responseContainerSelector}') not found. MutationObserver not started. Will rely on polling or debugger.`);
    // Optionally, retry finding the targetNode after a delay, or fall back to polling exclusively.
    // For now, we just warn and don't start the observer.
    return;
  }

  const config = { childList: true, subtree: true, characterData: true };

  const callback = (mutationsList, observer) => {
    // If not processing a message, or no current request, don't do anything.
    // This check is crucial to prevent processing mutations when not expected.
    if (!processingMessage || currentRequestId === null) {
        // console.log(CS_LOG_PREFIX, "MutationObserver: Ignoring mutation, not actively processing a message or no currentRequestId.");
        return;
    }
    
    // Let the provider handle the mutation and decide if it's relevant
    // The provider's handleMutation should call handleProviderResponse with the requestId
    try {
        provider.handleMutation(mutationsList, observer, currentRequestId, handleProviderResponse);
    } catch (e) {
        console.error(CS_LOG_PREFIX, "Error in provider.handleMutation:", e);
    }
  };

  const observer = new MutationObserver(callback);
  
  try {
      observer.observe(targetNode, config);
      console.log(CS_LOG_PREFIX, "MutationObserver started on:", targetNode);
  } catch (e) {
      console.error(CS_LOG_PREFIX, "Failed to start MutationObserver:", e, "on target:", targetNode);
      // Fallback or error handling if observer cannot be started
  }

  // Store the observer if we need to disconnect it later
  // e.g., window.chatRelayObserver = observer;
}


// Function to monitor for the completion of a response (e.g., when a "thinking" indicator disappears)
// This is a more generic version, specific providers might have more tailored logic.
function monitorResponseCompletion(element) {
  if (!provider || !provider.thinkingIndicatorSelector) {
    console.warn(CS_LOG_PREFIX, "Cannot monitor response completion: No thinkingIndicatorSelector in provider.");
    return;
  }

  const thinkingIndicator = document.querySelector(provider.thinkingIndicatorSelector);
  if (!thinkingIndicator) {
    // If the indicator is already gone, assume completion or it never appeared.
    // Provider's getResponseText should ideally capture the full text.
    console.log(CS_LOG_PREFIX, "Thinking indicator not found, assuming response is complete or was never present.");
    // Potentially call captureResponse one last time if needed by provider logic
    // captureResponse(null, true); // Example, might need adjustment
    return;
  }

  console.log(CS_LOG_PREFIX, "Thinking indicator found. Monitoring for its removal...");
  const observer = new MutationObserver((mutationsList, obs) => {
    // Check if the thinking indicator (or its parent, if it's removed directly) is no longer in the DOM
    // or if a specific class/attribute indicating completion appears.
    // This logic needs to be robust and provider-specific.
    
    // A simple check: if the element itself is removed or a known parent.
    // More complex checks might involve looking for specific classes on the response element.
    if (!document.body.contains(thinkingIndicator)) {
      console.log(CS_LOG_PREFIX, "Thinking indicator removed. Assuming response completion.");
      obs.disconnect();
      // Capture the final response
      // This assumes captureResponse can get the full text now.
      // The 'true' flag indicates this is considered the final capture.
      captureResponse(null, true); 
    }
    // Add other provider-specific checks here if needed
  });

  // Observe the parent of the thinking indicator for changes in its children (e.g., removal of the indicator)
  // Or observe attributes of the indicator itself if it changes state instead of being removed.
  if (thinkingIndicator.parentNode) {
    observer.observe(thinkingIndicator.parentNode, { childList: true, subtree: true });
  } else {
    console.warn(CS_LOG_PREFIX, "Thinking indicator has no parent node to observe. Cannot monitor for removal effectively.");
  }
}

// Specific monitoring for Gemini, if needed (example)
function monitorGeminiResponse(element) {
    // Gemini specific logic for monitoring response element for completion
    // This might involve looking for specific attributes or child elements
    // that indicate the stream has finished.
    console.log(CS_LOG_PREFIX, "Monitoring Gemini response element:", element);
    // Example: Observe for a specific class or attribute change
    const observer = new MutationObserver((mutationsList, obs) => {
        let isComplete = false;
        // Check mutations for signs of completion based on Gemini's DOM structure
        // For instance, a "generating" class is removed, or a "complete" attribute is set.
        // This is highly dependent on the actual Gemini interface.
        // Example (conceptual):
        // if (element.classList.contains('response-complete')) {
        //    isComplete = true;
        // }

        if (isComplete) {
            console.log(CS_LOG_PREFIX, "Gemini response detected as complete by mutation.");
            obs.disconnect();
            captureResponse(element, true); // Capture final response
        }
    });
    observer.observe(element, { attributes: true, childList: true, subtree: true });
    console.log(CS_LOG_PREFIX, "Gemini response observer started.");
}

function monitorGeminiContentStability(element) {
    let lastContent = "";
    let stableCount = 0;
    const STABLE_THRESHOLD = 3; // Number of intervals content must remain unchanged
    const CHECK_INTERVAL = 300; // Milliseconds

    console.log(CS_LOG_PREFIX, "Starting Gemini content stability monitoring for element:", element);

    const intervalId = setInterval(() => {
        if (!processingMessage || currentRequestId === null) {
            console.log(CS_LOG_PREFIX, "Gemini stability: Stopping, no longer processing message.");
            clearInterval(intervalId);
            return;
        }

        const currentContent = provider.getResponseText(element);
        if (currentContent === lastContent) {
            stableCount++;
            console.log(CS_LOG_PREFIX, `Gemini stability: Content stable, count: ${stableCount}`);
        } else {
            lastContent = currentContent;
            stableCount = 0; // Reset if content changes
            console.log(CS_LOG_PREFIX, `Gemini stability: Content changed. New length: ${currentContent.length}`);
            // Send partial update if provider wants it
            if (provider.sendPartialUpdates) {
                 handleProviderResponse(currentRequestId, currentContent, false);
            }
        }

        if (stableCount >= STABLE_THRESHOLD) {
            console.log(CS_LOG_PREFIX, "Gemini stability: Content stable for threshold. Assuming final.");
            clearInterval(intervalId);
            // Ensure the very latest content is captured and sent as final
            const finalContent = provider.getResponseText(element);
            handleProviderResponse(currentRequestId, finalContent, true);
        }
    }, CHECK_INTERVAL);
    responseMonitoringTimers.push(intervalId); // Store to clear if needed
}


// Function to capture the response text
// potentialTurnElement is passed by some providers (like Gemini) if they identify the specific response "turn" element
function captureResponse(potentialTurnElement = null, isFinal = false) {
  if (!provider || !provider.getResponseText) {
    console.error(CS_LOG_PREFIX, "Cannot capture response: No provider or getResponseText method.");
    if (currentRequestId !== null) {
        handleProviderResponse(currentRequestId, "Error: Provider misconfiguration for response capture.", true);
    }
    return;
  }

  // Use the potentialTurnElement if provided and valid, otherwise fall back to provider.responseSelector
  let responseElement = null;
  if (potentialTurnElement && typeof potentialTurnElement === 'object' && potentialTurnElement.nodeType === 1) {
      responseElement = potentialTurnElement;
      console.log(CS_LOG_PREFIX, "Using provided potentialTurnElement for capture:", responseElement);
  } else {
      if (!provider.responseSelector) {
          console.error(CS_LOG_PREFIX, "Cannot capture response: No responseSelector in provider and no valid potentialTurnElement given.");
          if (currentRequestId !== null) {
              handleProviderResponse(currentRequestId, "Error: Provider responseSelector missing.", true);
          }
          return;
      }
      responseElement = document.querySelector(provider.responseSelector);
      console.log(CS_LOG_PREFIX, "Using provider.responseSelector for capture:", provider.responseSelector);
  }

  if (!responseElement) {
    console.warn(CS_LOG_PREFIX, "Response element not found during capture.");
    // If it's supposed to be final and element is not found, it might be an issue.
    if (isFinal && currentRequestId !== null) {
        handleProviderResponse(currentRequestId, "Error: Response element not found for final capture.", true);
    }
    return;
  }

  const responseText = provider.getResponseText(responseElement);
  // isFinal flag is now passed as an argument, but provider might have its own check
  const trulyFinal = isFinal || (provider.isResponseComplete ? provider.isResponseComplete(responseElement) : false);

  console.log(CS_LOG_PREFIX, `Captured response (length: ${responseText.length}), isFinal: ${trulyFinal}. Passed isFinal: ${isFinal}`);
  
  if (currentRequestId === null) {
      console.warn(CS_LOG_PREFIX, "captureResponse: currentRequestId is null. Cannot send response to background.");
      return;
  }

  // Call handleProviderResponse, which will then relay to background
  // This centralizes the logic for sending FINAL_RESPONSE_TO_RELAY
  handleProviderResponse(currentRequestId, responseText, trulyFinal);
}

// Function to clear all active response monitoring timers
function clearResponseMonitoringTimers() {
    console.log(CS_LOG_PREFIX, `Clearing ${responseMonitoringTimers.length} response monitoring timers.`);
    responseMonitoringTimers.forEach(timerId => clearTimeout(timerId)); // Works for both setTimeout and setInterval IDs
    responseMonitoringTimers = []; // Reset the array
}

// Define message listener function *before* calling it
// Renamed setupAutomaticMessageSending to setupMessageListeners
function setupMessageListeners() { // Renamed from setupAutomaticMessageSending
  // Listen for commands from the background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "SEND_CHAT_MESSAGE") {
      const messageContent = message.messageContent; // Use messageContent
      let messagePreview = "";
      if (typeof messageContent === 'string') {
        messagePreview = `String: "${messageContent.substring(0, 50)}..."`;
      } else if (messageContent instanceof ArrayBuffer) {
        messagePreview = `ArrayBuffer data (size: ${messageContent.byteLength} bytes)`;
      } else if (messageContent instanceof Blob) {
        messagePreview = `Blob data (size: ${messageContent.size} bytes, type: ${messageContent.type})`;
      } else if (messageContent && typeof messageContent === 'object' && messageContent !== null) {
        messagePreview = `Object data (type: ${Object.prototype.toString.call(messageContent)})`;
      } else {
        messagePreview = `Data type: ${typeof messageContent}, Value: ${String(messageContent).substring(0,50)}`;
      }
      console.log(CS_LOG_PREFIX, "Received command to send message:", messagePreview, "Request ID:", message.requestId, "Last Processed Text:", message.lastProcessedText ? `"${message.lastProcessedText.substring(0,50)}..."` : "null");

      if (!provider) {
        console.error(CS_LOG_PREFIX, "Cannot send message: No provider detected.");
        sendResponse({ success: false, error: "No provider detected" });
        return true;
      }

      // Superseding / duplicate requestId logic (unchanged)
      if (processingMessage && currentRequestId !== null && currentRequestId !== message.requestId) {
        console.warn(CS_LOG_PREFIX, `New message (requestId: ${message.requestId}) received while request ${currentRequestId} was processing. The new message will supersede the old one.`);
        clearResponseMonitoringTimers();
        processingMessage = false;
        currentRequestId = null;
      } else if (processingMessage && currentRequestId === message.requestId) {
        console.warn(CS_LOG_PREFIX, `Received duplicate SEND_CHAT_MESSAGE for already processing requestId: ${message.requestId}. Ignoring duplicate command.`);
        sendResponse({ success: false, error: "Duplicate command for already processing requestId."});
        return true;
      }

      // Attempt to get the input field
      const inputField = document.querySelector(provider.inputSelector);
      let currentUIInputText = null;

      if (inputField) {
        currentUIInputText = inputField.value;
      } else {
        console.error(CS_LOG_PREFIX, "Input field not found via selector:", provider.inputSelector, "Cannot process SEND_CHAT_MESSAGE for requestId:", message.requestId);
        // Reset state if this was meant to be the current request
        if (currentRequestId === message.requestId) { // Check if we were about to set this as current
            processingMessage = false; // Ensure it's reset if it was about to become active
            // currentRequestId is not yet set to message.requestId here if it's a new command
        }
        sendResponse({ success: false, error: "Input field not found by content script." });
        return true;
      }

      // Duplicate Message Scenario Check:
      // 1. We have a record of the last processed text from the background script.
      // 2. The server is trying to send that exact same text again (messageContent === message.lastProcessedText).
      // 3. The UI input field also currently contains that exact same text (currentUIInputText === messageContent).
      let isDuplicateMessageScenario = false;
      if (typeof messageContent === 'string' && typeof message.lastProcessedText === 'string' && typeof currentUIInputText === 'string') {
        isDuplicateMessageScenario = message.lastProcessedText &&
                                     messageContent === message.lastProcessedText &&
                                     currentUIInputText === messageContent;
      }

      if (isDuplicateMessageScenario) {
        console.log(CS_LOG_PREFIX, `Duplicate message scenario detected for requestId: ${message.requestId}.`);
        console.log(CS_LOG_PREFIX, `  Server wants to send: "${messageContent.substring(0, 50)}..."`);
        console.log(CS_LOG_PREFIX, `  Last processed text was: "${message.lastProcessedText.substring(0, 50)}..."`);
        console.log(CS_LOG_PREFIX, `  Current UI input is: "${currentUIInputText.substring(0, 50)}..."`);
        
        console.log(CS_LOG_PREFIX, "Clearing input field and notifying background.");
        inputField.value = ''; // Clear the input field
        // Optionally, dispatch 'input' or 'change' events if the website needs them for reactivity
        // inputField.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));

        chrome.runtime.sendMessage({
          type: "DUPLICATE_MESSAGE_HANDLED",
          requestId: message.requestId,
          originalText: messageContent // The text that was duplicated
        }, response => {
          if (chrome.runtime.lastError) {
            console.error(CS_LOG_PREFIX, 'Error sending DUPLICATE_MESSAGE_HANDLED:', chrome.runtime.lastError.message);
          } else {
            console.log(CS_LOG_PREFIX, 'DUPLICATE_MESSAGE_HANDLED sent to background, response:', response);
          }
        });

        // This request is now considered "handled" by the content script (as a duplicate).
        // Reset content script's immediate processing state if this was about to become the active request.
        // Note: currentRequestId might not yet be message.requestId if this is a brand new command.
        // The background script will manage its own processingRequest flag based on DUPLICATE_MESSAGE_HANDLED.
        // For content.js, we ensure we don't proceed to send this.
        // If currentRequestId was already message.requestId (e.g. from a retry/glitch), reset it.
        if (currentRequestId === message.requestId) {
            processingMessage = false;
            currentRequestId = null;
        }
        
        sendResponse({ success: true, message: "Duplicate message scenario handled by clearing input." });
        return true;
      }

      // If not a duplicate, proceed with normal sending logic:
      console.log(CS_LOG_PREFIX, `Not a duplicate scenario for requestId: ${message.requestId}. Proceeding to send.`);
      processingMessage = true;
      currentRequestId = message.requestId;
      console.log(CS_LOG_PREFIX, `Set currentRequestId to ${currentRequestId} for processing.`);

      // Use the new handleIncomingChatMessage entry point
      if (provider && typeof handleIncomingChatMessage === 'function') {
          handleIncomingChatMessage(messageContent, message)
              .then(success => {
                if (success) {
                  console.log(CS_LOG_PREFIX, `Message processing started successfully for requestId: ${message.requestId}.`);
                  sendResponse({ success: true, message: "Message processing started." });
                } else {
                  console.error(CS_LOG_PREFIX, `Failed to process message for requestId: ${message.requestId}.`);
                  sendResponse({ success: false, error: "Failed to process message." });
                }
              }).catch(error => {
                console.error(CS_LOG_PREFIX, `Error handling message for requestId: ${message.requestId}:`, error);
                sendResponse({ success: false, error: `Error: ${error.message}` });
              });
      } else {
        console.error(CS_LOG_PREFIX, "Provider or handleIncomingChatMessage is not available for requestId:", message.requestId);
        processingMessage = false;
        currentRequestId = null;
        sendResponse({ success: false, error: "Provider or handleIncomingChatMessage missing." });
      }
      return true; // Indicate async response
    } else if (message.type === "DEBUGGER_RESPONSE" || message.type === "PROVIDER_DEBUGGER_EVENT") {
      console.log(CS_LOG_PREFIX, `Received ${message.type} message object:`, JSON.stringify(message)); // Log full received message
      console.log(CS_LOG_PREFIX, `Processing ${message.type} for app requestId: ${currentRequestId}. Debugger requestId: ${message.requestId}. Data length: ${message.data ? message.data.length : 'null'}`);
      if (!provider) {
          console.error(CS_LOG_PREFIX, `Received ${message.type} but no provider is active.`);
          sendResponse({ success: false, error: "No provider active." });
          return true;
      }
      if (typeof provider.handleDebuggerData !== 'function') {
          console.error(CS_LOG_PREFIX, `Provider ${provider.name} does not implement handleDebuggerData.`);
          sendResponse({ success: false, error: `Provider ${provider.name} does not support debugger method.` });
          return true;
      }
      // IMPORTANT: The message.requestId IS the application's original requestId,
      // associated by background.js. We should use this directly.
      // The content.js currentRequestId might have been cleared if the provider.sendChatMessage failed,
      // but the debugger stream might still be valid for message.requestId.
      const eventDetail = message.detail || message; // Handle both direct and nested details
      const requestId = eventDetail.requestId;
      const responseData = eventDetail.data;
      const isFinal = eventDetail.isFinal;
      const errorFromBackground = eventDetail.error || null;

      if (requestId === undefined || requestId === null) { // Check if requestId is missing or invalid
          console.error(CS_LOG_PREFIX, `Received ${message.type} without a valid requestId. Ignoring. Message:`, message);
          sendResponse({ success: false, error: `${message.type} missing requestId.` });
          return true;
      }

      // Pass the raw data, the message's requestId, and isFinal flag to the provider
      // The provider's handleDebuggerData is responsible for calling handleProviderResponse
      console.log(CS_LOG_PREFIX, `Calling provider.handleDebuggerData for requestId: ${requestId} with isFinal: ${isFinal}, errorFromBackground: ${errorFromBackground}`); // Log before call
      provider.handleDebuggerData(requestId, responseData, isFinal, errorFromBackground, handleProviderResponse); // Pass extracted data
      // Acknowledge receipt of the debugger data
      sendResponse({ success: true, message: "Debugger data (and potential error) passed to provider." });
      return true; // Indicate async response (provider will eventually call handleProviderResponse)

    } else if (message.type === "PING_TAB") {
      console.log(CS_LOG_PREFIX, "Received PING_TAB from background script.");
      sendResponse({ success: true, message: "PONG" });
      return true;
    } else if (message.action === "STOP_STREAMING") {
      console.log(CS_LOG_PREFIX, `Received STOP_STREAMING command for requestId: ${message.requestId}`);
      if (provider && typeof provider.stopStreaming === 'function') {
        provider.stopStreaming(message.requestId);
        // The handleProviderResponse might have already cleared currentRequestId if it matched.
        // We ensure processingMessage is false if this was the active request.
        if (currentRequestId === message.requestId) {
            processingMessage = false;
            currentRequestId = null; // Explicitly clear here as well
            clearResponseMonitoringTimers(); // Ensure any DOM timers are also cleared
            console.log(CS_LOG_PREFIX, `STOP_STREAMING: Cleared active currentRequestId ${message.requestId} and processingMessage flag.`);
        }
        sendResponse({ success: true, message: `Streaming stopped for requestId: ${message.requestId}` });
      } else {
        console.error(CS_LOG_PREFIX, "Provider or provider.stopStreaming is not available for STOP_STREAMING command.");
        sendResponse({ success: false, error: "Provider or stopStreaming method missing." });
      }
      return true;
    } else if (message.action === 'HANDLE_WEBSOCKET_DATA') {
      console.log(CS_LOG_PREFIX, `Received HANDLE_WEBSOCKET_DATA for requestId: ${message.requestId}`);
      // Note: We use the globally scoped 'provider' variable here.
      // It should be correctly set by the time this message is received.
      if (provider && typeof provider.handleWebSocketData === 'function') {
        provider.handleWebSocketData(message.requestId, message.data);
        sendResponse({ success: true, message: "WebSocket data passed to provider." });
      } else {
        console.error(CS_LOG_PREFIX, "Cannot handle WebSocket data: Provider not found or does not support handleWebSocketData method.");
        sendResponse({ success: false, error: 'Provider not found or does not support WebSocket data' });
      }
      return true;
    }
 
    // Handle other potential message types if needed
    // else if (message.type === '...') { ... }
 
    // If the message type isn't handled, return false or undefined
    console.log(CS_LOG_PREFIX, "Unhandled message type received:", message.type || message.action);
    // sendResponse({ success: false, error: "Unhandled message type" }); // Optional: send error back
    // return false; // Or let it be undefined
  });
}

// Generic callback function passed to the provider.
// The provider calls this when it has determined the final response or a chunk of it.
function handleProviderResponse(requestId, responseText, isFinal) {
  console.log(CS_LOG_PREFIX, `handleProviderResponse called for requestId: ${requestId}. Data length: ${responseText ? String(responseText).length : 'null'}. isFinal: ${isFinal}. Data (first 100 chars): '${(responseText || "").substring(0,100)}', Type: ${typeof responseText}`);

  // Log to relay server for debugging
  if (isFinal || (responseText && responseText.length % 100 === 0)) {
      logRemote('info', `Content script sending response for req ${requestId} (final: ${isFinal}, len: ${responseText ? responseText.length : 0})`, requestId);
  }
  // This should be the definitive requestId for this piece of data.
  // We log if content.js's currentRequestId is different, but proceed with the passed 'requestId'.
  if (currentRequestId !== requestId && currentRequestId !== null) { // also check currentRequestId is not null to avoid warning on initial load or after reset
      console.warn(CS_LOG_PREFIX, `handleProviderResponse: content.js currentRequestId (${currentRequestId}) differs from provider's response requestId (${requestId}). Proceeding with provider's requestId for data relay.`);
  }
  // Continue to process with the 'requestId' passed to this function.

  if (chrome.runtime && chrome.runtime.sendMessage) {
      const MAX_RESPONSE_TEXT_LENGTH = 500 * 1024; // 500KB limit for safety
      let messageToSendToBackground;

      // Encode special Unicode characters before transmission
      const encodedText = responseText ? encodeURIComponent(responseText) : "";
      
      if (responseText && typeof responseText === 'string' && responseText.length > MAX_RESPONSE_TEXT_LENGTH) {
          console.warn(CS_LOG_PREFIX, `ResponseText for requestId ${requestId} is too large (${responseText.length} bytes). Sending error and truncated text.`);
          messageToSendToBackground = {
              type: "FINAL_RESPONSE_TO_RELAY",
              requestId: requestId,
              error: `Response too large to transmit (length: ${responseText.length}). Check content script logs for truncated version.`,
              text: `Error: Response too large (length: ${responseText.length}). See AI Studio for full response.`,
              isFinal: true,
              encoded: true
          };
      } else {
          messageToSendToBackground = {
              type: "FINAL_RESPONSE_TO_RELAY",
              requestId: requestId,
              text: encodedText,
              isFinal: isFinal,
              encoded: true
          };
      }

      console.log(CS_LOG_PREFIX, `[REQ-${requestId}] PRE-SEND to BG: Type: ${messageToSendToBackground.type}, isFinal: ${messageToSendToBackground.isFinal}, HasError: ${!!messageToSendToBackground.error}, TextLength: ${messageToSendToBackground.text ? String(messageToSendToBackground.text).length : (messageToSendToBackground.error ? String(messageToSendToBackground.error).length : 'N/A')}`);
      try {
          chrome.runtime.sendMessage(messageToSendToBackground, response => {
              if (chrome.runtime.lastError) {
                  console.error(CS_LOG_PREFIX, `[REQ-${requestId}] SEND FAILED to BG: ${chrome.runtime.lastError.message}. Message attempted:`, JSON.stringify(messageToSendToBackground).substring(0, 500));
              } else {
                  console.log(CS_LOG_PREFIX, `[REQ-${requestId}] SEND SUCCESS to BG. Ack from BG:`, response);
              }
          });
      } catch (syncError) {
          console.error(CS_LOG_PREFIX, `[REQ-${requestId}] SYNC ERROR sending to BG: ${syncError.message}. Message attempted:`, JSON.stringify(messageToSendToBackground).substring(0, 500), syncError);
      }
  } else {
      console.error(CS_LOG_PREFIX, "Cannot send FINAL_RESPONSE_TO_RELAY, runtime is invalid.");
  }

  if (isFinal) {
    // Reset content script state AFTER sending the final response message,
    // but only if the finalized requestId matches what content.js currently considers its active request.
    if (currentRequestId === requestId) {
      processingMessage = false;
      currentRequestId = null;
      clearResponseMonitoringTimers(); // Clear any timers associated with this request
      console.log(CS_LOG_PREFIX, `Processing finished for active requestId: ${requestId}. State reset in content.js.`);
    } else {
      console.log(CS_LOG_PREFIX, `Processing finished for requestId: ${requestId}. This was not the active content.js requestId (${currentRequestId}), so content.js state not altered by this finalization. However, timers for ${requestId} might need explicit cleanup if any were started by it.`);
      // If specific timers were associated with 'requestId' (not currentRequestId), they should be cleared by the provider or a more granular timer management.
    }
  } else {
    console.log(CS_LOG_PREFIX, `Partial response processed for requestId: ${requestId}. Awaiting more data or final flag.`);
  }
}


// Call initialization functions
// Ensure DOM is ready for provider detection and DOM manipulations
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attemptInitialization);
} else {
    attemptInitialization(); // DOMContentLoaded has already fired
}

function attemptInitialization() {
    console.log(CS_LOG_PREFIX, "Attempting initialization...");
    console.log(CS_LOG_PREFIX, "Current URL:", window.location.href);
    console.log(CS_LOG_PREFIX, "Current hostname:", window.location.hostname);
    
    // Add event listener for late provider registration
    window.addEventListener('providerRegistered', (e) => {
      console.log(CS_LOG_PREFIX, `Caught 'providerRegistered' event for ${e.detail.providerName}. Re-initializing.`);
      // Reset parts of the state before re-initializing
      provider = null;
      initializeContentRelay();
    });

    if (window.attemptedInitialization) {
        console.log(CS_LOG_PREFIX, "Initialization already attempted. Skipping subsequent calls to attemptInitialization.");
        return;
    }
    window.attemptedInitialization = true;
    
    try {
        console.log(CS_LOG_PREFIX, "Starting initializeContentRelay...");
        initializeContentRelay(); // Initialize provider detection, DOM setup, etc.
        console.log(CS_LOG_PREFIX, "initializeContentRelay completed successfully");
        
        console.log(CS_LOG_PREFIX, "Starting setupMessageListeners...");
        setupMessageListeners();  // Setup listeners for messages from background script
        console.log(CS_LOG_PREFIX, "setupMessageListeners completed successfully");
        
        console.log(CS_LOG_PREFIX, "Initialization attempt complete. Message listeners set up.");
        
        // Send a test message to background to confirm connection
        chrome.runtime.sendMessage({
            type: "CONTENT_SCRIPT_LOADED",
            url: window.location.href,
            hostname: window.location.hostname
        }, response => {
            if (chrome.runtime.lastError) {
                console.error(CS_LOG_PREFIX, 'Error sending CONTENT_SCRIPT_LOADED:', chrome.runtime.lastError.message);
            } else {
                console.log(CS_LOG_PREFIX, 'CONTENT_SCRIPT_LOADED sent successfully, response:', response);
            }
        });
        
    } catch (error) {
        console.error(CS_LOG_PREFIX, "Error during initialization:", error);
        console.error(CS_LOG_PREFIX, "Error stack:", error.stack);
    }
}

