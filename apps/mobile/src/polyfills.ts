/**
 * Polyfills, imported before anything else.
 *
 * React Native has no Buffer and no crypto.getRandomValues, and web3.js needs
 * both. react-native-get-random-values has to be first, because web3.js reads
 * crypto at import time.
 */
import "react-native-get-random-values";
import { Buffer } from "buffer";

if (typeof global.Buffer === "undefined") {
  global.Buffer = Buffer;
}
