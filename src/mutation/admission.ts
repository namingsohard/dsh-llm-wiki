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
export const ADMISSION_DIMENSIONS = {
  reusability: 'Will future tasks plausibly reuse this knowledge?',
  stability: 'Does it stay valid over weeks/months rather than this session?',
  novelty: 'Does it add something the wiki does not already hold?',
  abstraction: 'Is it a knowledge summary rather than a transient event log?',
} as const;

const DIMENSION_KEYS = ['reusability', 'stability', 'novelty', 'abstraction'] as const;

/** Validate raw scores; throws with a precise message on malformed input. */
export function assertAdmissionScores(raw: unknown): AdmissionScores {
  if (typeof raw !== 'object' || raw === null) throw new Error('admission must be an object with the four score dimensions');
  const record = raw as Record<string, unknown>;
  const out = {} as AdmissionScores;
  for (const key of DIMENSION_KEYS) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 3) {
      throw new Error(`admission.${key} must be an integer 0..3 (got ${JSON.stringify(value)})`);
    }
    out[key] = value;
  }
  return out;
}

/** Evaluate a candidate against the configured thresholds. */
export function evaluateAdmission(scores: AdmissionScores, config: Pick<WikiConfig, 'admissionMinAverage' | 'admissionMinIndividual'>): AdmissionVerdict {
  const values = DIMENSION_KEYS.map((key) => scores[key]);
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const minimum = Math.min(...values);
  const reasons: string[] = [];
  if (minimum < config.admissionMinIndividual) {
    const weak = DIMENSION_KEYS.filter((key) => scores[key] < config.admissionMinIndividual);
    reasons.push(`below individual floor ${config.admissionMinIndividual}: ${weak.join(', ')}`);
  }
  if (average < config.admissionMinAverage) reasons.push(`average ${average.toFixed(2)} below threshold ${config.admissionMinAverage}`);
  return { accept: reasons.length === 0, average: Math.round(average * 100) / 100, minimum, reasons };
}
