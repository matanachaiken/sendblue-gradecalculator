import type { ClassData, Intent, ParsedSyllabus, AssignmentMatch, Category, CanvasAssignment } from './types.js';
/**
 * Parse a syllabus image by passing its URL directly to Claude.
 * Simplest approach — no download needed if the URL is publicly accessible.
 */
export declare function parseSyllabusFromUrl(imageUrl: string, className: string | null): Promise<ParsedSyllabus | null>;
/**
 * Parse a syllabus image from a pre-downloaded base64 buffer.
 * Used as a fallback when the URL requires auth headers to download.
 */
export declare function parseSyllabusFromImage(base64Data: string, mediaType: string, className: string | null): Promise<ParsedSyllabus | null>;
/**
 * Parse a messy syllabus grading section into structured categories.
 */
export declare function parseSyllabus(className: string | null, syllabusText: string): Promise<ParsedSyllabus | null>;
/**
 * Classify what the user wants to do and extract the relevant details.
 */
export declare function classifyIntent(message: string, classes: Record<string, ClassData>): Promise<Intent>;
/**
 * Match a batch of Canvas assignments to syllabus grading categories.
 * Uses a single Claude call so syncing 30 assignments costs one API call, not 30.
 */
export declare function batchMatchAssignments(assignments: CanvasAssignment[], categories: Category[]): Promise<Record<string, AssignmentMatch>>;
