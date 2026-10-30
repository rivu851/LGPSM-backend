"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clock = void 0;
// The server's clock, in one place so time-dependent rules (admission windows) can be tested at an exact instant.
// Production always returns the real time; nothing a client sends can reach this.
exports.clock = {
    now: () => new Date()
};
