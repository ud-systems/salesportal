#!/usr/bin/env node
/**
 * Generate VAPID keys for Web Push. Add to:
 *   - Supabase Edge secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
 *   - Optional frontend .env: VITE_VAPID_PUBLIC_KEY=<publicKey>
 */
import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();
console.log("VAPID_PUBLIC_KEY=" + keys.publicKey);
console.log("VAPID_PRIVATE_KEY=" + keys.privateKey);
console.log("VITE_VAPID_PUBLIC_KEY=" + keys.publicKey);
console.log("\nVAPID_SUBJECT=mailto:sales@uniquedistribution.co.uk");
