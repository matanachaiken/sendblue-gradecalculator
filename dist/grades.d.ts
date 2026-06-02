import type { ClassData, GradeResult, GpaResult } from './types.js';
/**
 * Calculate the current weighted grade.
 * Curves are applied to the final grade, not per category.
 */
export declare function calcCurrentGrade(classData: ClassData): GradeResult | null;
/**
 * What raw score is needed on remaining assignments to hit a target grade
 * after the curve is applied?
 *
 * Returns null for norm curves (letter-based, can't project numerically)
 * or when nothing is left to grade.
 */
export declare function calcNeeded(classData: ClassData, targetCurvedGrade: number): number | null;
/**
 * Calculate the best possible grade assuming 100 on all remaining assignments.
 * Returns same shape as calcCurrentGrade, or null if all categories already have grades.
 */
export declare function calcBestPossible(classData: ClassData): GradeResult | null;
/**
 * Calculate semester GPA across all classes.
 */
export declare function calcGPA(classes: Record<string, ClassData>): GpaResult;
/**
 * Map a numeric percentage to a letter grade using standard cutoffs.
 */
export declare function getLetterGrade(pct: number): string;
