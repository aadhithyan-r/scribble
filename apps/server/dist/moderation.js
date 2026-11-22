import { randomUUID } from "node:crypto";
import { ValidationError } from "./validation.js";
const REPORT_COOLDOWN_MS = 60_000;
const MAX_REPORTS = 500;
/**
 * In-memory report intake for the server session. It intentionally exposes
 * nothing publicly: only the room host can read the reports for their room,
 * and Phase 5 can persist this without changing the payloads.
 */
export class ReportStore {
    reports = [];
    lastByPair = new Map();
    add(input, now = Date.now()) {
        const reason = input.reason.replace(/\s+/g, " ").trim();
        if (reason.length < 5 || reason.length > 200) {
            throw new ValidationError("INVALID_REPORT", "Describe the problem in 5–200 characters");
        }
        const key = `${input.reporterProfileId}:${input.targetProfileId ?? input.targetId}`;
        const last = this.lastByPair.get(key) ?? 0;
        if (now - last < REPORT_COOLDOWN_MS) {
            throw new ValidationError("REPORT_RATE_LIMITED", "You already reported this player recently");
        }
        this.lastByPair.set(key, now);
        const report = { ...input, reason, id: randomUUID(), at: now };
        this.reports.push(report);
        if (this.reports.length > MAX_REPORTS)
            this.reports.shift();
        return report;
    }
    forRoom(code) {
        return this.reports.filter((report) => report.roomCode === code).map((report) => ({ ...report }));
    }
}
