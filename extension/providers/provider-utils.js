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
// AI Chat Relay - Provider Utilities

{
// Map of supported domains to provider instances
const providerMap = {}; // Stores { domain: { name: providerName, instance: providerObject } }

// Register a provider with its supported domains and instance
function registerProvider(providerName, domains, providerInstance) {
  console.log("PROVIDER-UTILS: registerProvider called with:", { providerName, domains, providerInstance: !!providerInstance });
  
  if (!providerName || !Array.isArray(domains) || !providerInstance) {
    console.error("PROVIDER-UTILS: Invalid arguments for registerProvider.", { providerName, domains, providerInstance });
    return;
  }
  
  domains.forEach(domain => {
    providerMap[domain] = { name: providerName, instance: providerInstance };
    console.log("PROVIDER-UTILS: Mapped domain", domain, "to provider", providerName);
  });
  
  console.log("PROVIDER-UTILS: Registered provider:", providerName, "for domains:", domains);
  console.log("PROVIDER-UTILS: Current providerMap after registration:", providerMap);

  // Dispatch a custom event to notify that a provider has been registered
  const event = new CustomEvent('providerRegistered', {
    detail: {
      providerName: providerName,
      domains: domains
    }
  });
  window.dispatchEvent(event);
  console.log("PROVIDER-UTILS: Dispatched 'providerRegistered' event for", providerName);
}

// Detect the provider for the current page
function detectProvider(hostname) {
  // Ensure hostname is a string before calling .includes()
  if (typeof hostname !== 'string') {
    console.warn("PROVIDER-UTILS: Invalid hostname for detectProvider:", hostname);
    return null;
  }

  console.log("PROVIDER-UTILS: Detecting provider for hostname:", hostname);
  console.log("PROVIDER-UTILS: Current providerMap:", providerMap); // Log current map for debugging

  for (const domainKey in providerMap) {
    if (hostname.includes(domainKey)) {
      const providerData = providerMap[domainKey];
      console.log("PROVIDER-UTILS: Found provider", providerData.name, "for hostname", hostname);
      return providerData.instance;
    }
  }
  
  console.log("PROVIDER-UTILS: No provider found for hostname:", hostname);
  return null;
}

// Export the functions
window.providerUtils = {
  detectProvider,
  registerProvider, // Expose registerProvider
  getProviderForUrl: (url) => {
    const hostname = new URL(url).hostname;
    return detectProvider(hostname);
  }
};
}