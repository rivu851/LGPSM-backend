"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashPassword = hashPassword;
exports.verifyPassword = verifyPassword;
const bcrypt_1 = __importDefault(require("bcrypt"));
// 10 rounds in production; the test suite hashes hundreds of passwords, so it uses the cheapest setting
const SALT_ROUNDS = process.env.NODE_ENV === 'test' ? 4 : 10;
async function hashPassword(password) {
    const salt = await bcrypt_1.default.genSalt(SALT_ROUNDS);
    return bcrypt_1.default.hash(password, salt);
}
async function verifyPassword(password, hash) {
    return bcrypt_1.default.compare(password, hash);
}
