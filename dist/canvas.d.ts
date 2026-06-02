import type { CanvasCourse, CanvasAssignment } from './types.js';
/**
 * Validate a token by listing active courses. Returns the course list.
 */
export declare function getCourses(baseUrl: string, token: string): Promise<CanvasCourse[]>;
/**
 * Get every GRADED assignment for a course, with scores converted to percentages.
 * Canvas assignment group weights are intentionally ignored here — the caller
 * maps these scores to syllabus categories using batchMatchAssignments() in claude.ts.
 */
export declare function getScoredAssignments(baseUrl: string, token: string, courseId: number): Promise<CanvasAssignment[]>;
