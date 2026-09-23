import type { AdmissionScores, AdmissionVerdict } from '../types.js';
import type { WikiConfig } from '../config.js';
/**
 * Admission Controller: decides whether extracted candidate knowledge enters
 * the Wiki Layer. Every CREATE must argue its case on the blueprint's four
 * dimensions — Reusability, Stability, Novelty, Abstraction — each scored
 * 0..3 by the extracting agent. Temporary events and one-off facts fail the
 * gate and are journaled as rejected instead of silently written.
 *
 * @module dsh-llm-wiki/mutation/admission
 */
/** One-line meaning per dimension, reused in tool descriptions. */
export declare const ADMISSION_DIMENSIONS: {
    readonly reusability: "Will future tasks plausibly reuse this knowledge?";
    readonly stability: "Does it stay valid over weeks/months rather than this session?";
    readonly novelty: "Does it add something the wiki does not already hold?";
    readonly abstraction: "Is it a knowledge summary rather than a transient event log?";
};
/** Validate raw scores; throws with a precise message on malformed input. */
export declare function assertAdmissionScores(raw: unknown): AdmissionScores;
/** Evaluate a candidate against the configured thresholds. */
export declare function evaluateAdmission(scores: AdmissionScores, config: Pick<WikiConfig, 'admissionMinAverage' | 'admissionMinIndividual'>): AdmissionVerdict;
//# sourceMappingURL=admission.d.ts.map