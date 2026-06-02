// grades.js — Grade math: weighted averages, curves applied to final grade, projections

function avg(arr) {
  if (!arr || arr.length === 0) return null;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

function r1(n) {
  return Math.round(n * 10) / 10;
}

// Grade scale, best to worst (index 0 = A, index 9 = F)
const GRADE_SCALE = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D', 'F'];

/**
 * Compute effective weights for every category, accounting for dynamic
 * best/worst midterm rules.
 *
 * When both dynamic categories have scores:
 *   - higher scorer gets bestWeight, lower gets worstWeight
 * When only one has a score:
 *   - both keep their base weight from the categories array
 *   - a pending note is attached so the display can inform the user
 *
 * Returns: { [catKey]: { weight: number, note: string|null } }
 */
function getEffectiveWeights(classData) {
  const { categories, grades = {}, dynamicWeights } = classData;
  const result = {};
  for (const cat of categories) {
    result[cat.name.toLowerCase()] = { weight: cat.weight, note: null };
  }

  if (dynamicWeights?.type === 'best_worst') {
    const keyA = dynamicWeights.categoryA.toLowerCase();
    const keyB = dynamicWeights.categoryB.toLowerCase();
    const scoreA = avg(grades[keyA] || []);
    const scoreB = avg(grades[keyB] || []);

    if (scoreA !== null && scoreB !== null) {
      // Both entered — assign best/worst weights
      if (scoreA >= scoreB) {
        result[keyA] = { weight: dynamicWeights.bestWeight,  note: `${dynamicWeights.bestWeight}% — higher` };
        result[keyB] = { weight: dynamicWeights.worstWeight, note: `${dynamicWeights.worstWeight}% — lower` };
      } else {
        result[keyA] = { weight: dynamicWeights.worstWeight, note: `${dynamicWeights.worstWeight}% — lower` };
        result[keyB] = { weight: dynamicWeights.bestWeight,  note: `${dynamicWeights.bestWeight}% — higher` };
      }
    } else if (scoreA !== null || scoreB !== null) {
      // Only one entered — keep base weights, add pending note
      const pendingNote = 'weights will auto-adjust when both midterms are entered';
      if (result[keyA]) result[keyA] = { ...result[keyA], note: pendingNote };
      if (result[keyB]) result[keyB] = { ...result[keyB], note: pendingNote };
    }
  }

  return result;
}

/**
 * Apply curve to the final weighted grade — never to individual categories.
 *
 * Curve types:
 *   flat  — add flatPoints, cap at 100
 *   mean  — shift by (targetMean - classAvg), never negative, cap at 100
 *   norm  — map position relative to median to a letter grade
 *   none  — no adjustment
 *
 * @returns {{
 *   curvedGrade:  number,       // numeric result (unchanged for norm/none)
 *   curvedLetter: string|null,  // letter grade (null when not applicable or pending)
 *   pending:      boolean,      // true if required curve data hasn't been entered yet
 *   note:         string        // human-readable description
 * }}
 */
function applyCurveToFinal(rawGrade, curve) {
  if (!curve || curve.type === 'none') {
    return { curvedGrade: rawGrade, curvedLetter: null, pending: false, note: '' };
  }

  if (curve.type === 'flat') {
    const pts = curve.flatPoints || 0;
    const curved = Math.min(100, rawGrade + pts);
    // Return full-precision curvedGrade; caller rounds for display
    return { curvedGrade: curved, curvedLetter: getLetterGrade(curved), pending: false, note: `+${pts} pts flat` };
  }

  if (curve.type === 'mean') {
    if (curve.targetMean == null) {
      return { curvedGrade: rawGrade, curvedLetter: null, pending: true, note: 'Target mean not set' };
    }
    if (curve.classAvg == null) {
      return { curvedGrade: rawGrade, curvedLetter: null, pending: true, note: 'Enter the class average of final grades to apply the curve' };
    }
    const shift = curve.targetMean - curve.classAvg;
    if (shift <= 0) {
      return { curvedGrade: rawGrade, curvedLetter: getLetterGrade(rawGrade), pending: false, noShift: true, note: `class avg (${curve.classAvg}) was already above the target (${curve.targetMean}) — no curve applied` };
    }
    const curved = Math.min(100, rawGrade + shift);
    return { curvedGrade: curved, curvedLetter: getLetterGrade(curved), pending: false, note: `+${r1(shift)} pts (scale to mean ${curve.targetMean})` };
  }

  if (curve.type === 'norm') {
    if (curve.median == null) {
      return { curvedGrade: rawGrade, curvedLetter: null, pending: true, note: 'Enter the class median to apply the curve' };
    }
    if (!curve.mappedGrade) {
      return { curvedGrade: rawGrade, curvedLetter: null, pending: true, note: 'Enter the letter grade the professor maps the median to' };
    }

    const baseIdx = GRADE_SCALE.indexOf(curve.mappedGrade);
    if (baseIdx < 0) {
      return { curvedGrade: rawGrade, curvedLetter: null, pending: true, note: `Unrecognized mapped grade "${curve.mappedGrade}"` };
    }

    let curvedLetter;
    if (rawGrade >= curve.median) {
      const distanceAbove = rawGrade - curve.median;
      const roomAbove = 100 - curve.median;
      const percentile = roomAbove > 0 ? distanceAbove / roomAbove : 0;
      const stepsAbove = baseIdx; // number of letter grades above the mapped grade
      const stepsUp = Math.round(percentile * stepsAbove);
      curvedLetter = GRADE_SCALE[Math.max(0, baseIdx - stepsUp)];
    } else {
      const distanceBelow = curve.median - rawGrade;
      const roomBelow = curve.median;
      const percentile = roomBelow > 0 ? distanceBelow / roomBelow : 0;
      const stepsBelow = GRADE_SCALE.length - 1 - baseIdx; // grades below mapped grade
      const stepsDown = Math.round(percentile * stepsBelow);
      curvedLetter = GRADE_SCALE[Math.min(GRADE_SCALE.length - 1, baseIdx + stepsDown)];
    }

    return {
      curvedGrade: rawGrade, // norm doesn't change the numeric grade
      curvedLetter,
      pending: false,
      note: `norm-referenced (median ${curve.median} → ${curve.mappedGrade})`,
    };
  }

  return { curvedGrade: rawGrade, curvedLetter: null, pending: false, note: '' };
}

function applyDropLowest(grades, dropLowest) {
  if (!dropLowest || grades.length <= dropLowest) return grades;
  return [...grades].sort((a, b) => a - b).slice(dropLowest);
}

function mergeGrades(classData) {
  const manual = classData.grades || {};
  const canvas = classData.canvasGrades || {};
  const merged = {};
  const keys = new Set([...Object.keys(manual), ...Object.keys(canvas)]);
  for (const key of keys) {
    merged[key] = [...(manual[key] || []), ...(canvas[key] || [])];
  }
  return merged;
}

/**
 * Calculate the current weighted grade.
 * Curves are applied to the final grade, not per category.
 *
 * @returns {{
 *   rawGrade:       number,
 *   curvedGrade:    number,
 *   curvedLetter:   string|null,
 *   curvePending:   boolean,
 *   curveNote:      string,
 *   completedWeight: number,
 *   breakdown:      Array
 * } | null}
 */
export function calcCurrentGrade(classData) {
  const { categories } = classData;
  const grades = mergeGrades(classData);

  let weightedSum = 0;
  let completedWeight = 0;
  const breakdown = [];

  const effectiveWeights = getEffectiveWeights(classData);

  for (const cat of categories) {
    const key = cat.name.toLowerCase();
    const catGrades = grades[key];
    if (!catGrades || catGrades.length === 0) continue;

    const effectiveGrades = applyDropLowest(catGrades, cat.dropLowest);
    const rawAvg = avg(effectiveGrades); // full precision — do not round here
    const { weight, note } = effectiveWeights[key];
    weightedSum += rawAvg * weight;
    completedWeight += weight;

    breakdown.push({
      name: cat.name,
      weight,
      rawAvg: r1(rawAvg), // round only for display in the breakdown
      count: effectiveGrades.length,
      droppedCount: catGrades.length - effectiveGrades.length,
      weightNote: note,
    });
  }

  if (completedWeight === 0) return null;

  const rawGrade = weightedSum / completedWeight; // full precision — round below, not here
  const { curvedGrade, curvedLetter, pending, noShift, note } = applyCurveToFinal(rawGrade, classData.curve);

  return {
    rawGrade: r1(rawGrade),       // round here, once, for display
    curvedGrade: r1(curvedGrade), // round here, once, for display
    curvedLetter,
    curvePending: pending,
    curveNoShift: noShift || false,
    curveNote: note,
    completedWeight,
    breakdown,
  };
}

/**
 * What raw score is needed on remaining assignments to hit a target grade
 * after the curve is applied?
 *
 * Returns null for norm curves (letter-based, can't project numerically)
 * or when nothing is left to grade.
 */
export function calcNeeded(classData, targetCurvedGrade) {
  const { categories, curve } = classData;
  const grades = mergeGrades(classData);

  // Norm curve is letter-based — projection not possible
  if (curve?.type === 'norm') return null;

  // Reverse the curve to find the needed raw grade
  let targetRaw = targetCurvedGrade;
  if (curve?.type === 'flat') {
    targetRaw = targetCurvedGrade - (curve.flatPoints || 0);
  } else if (curve?.type === 'mean') {
    const shift = (curve.targetMean != null && curve.classAvg != null)
      ? Math.max(0, curve.targetMean - curve.classAvg)
      : 0;
    targetRaw = targetCurvedGrade - shift;
  }

  const effectiveWeights = getEffectiveWeights(classData);
  let completedSum = 0;
  let completedWeight = 0;
  let remainingWeight = 0;

  for (const cat of categories) {
    const key = cat.name.toLowerCase();
    const catGrades = grades[key];
    if (catGrades && catGrades.length > 0) {
      const { weight } = effectiveWeights[key];
      completedSum += avg(applyDropLowest(catGrades, cat.dropLowest)) * weight;
      completedWeight += weight;
    } else {
      remainingWeight += cat.weight; // base weight for projection of ungraded work
    }
  }

  if (remainingWeight === 0) return null;

  const totalWeight = completedWeight + remainingWeight;
  const needed = (targetRaw * totalWeight - completedSum) / remainingWeight;
  return r1(needed);
}

/**
 * Calculate the best possible grade assuming 100 on all remaining assignments.
 * Returns same shape as calcCurrentGrade, or null if all categories already have grades.
 */
export function calcBestPossible(classData) {
  const merged = mergeGrades(classData);
  const hasRemaining = classData.categories.some(cat => {
    const key = cat.name.toLowerCase();
    return !merged[key] || merged[key].length === 0;
  });
  if (!hasRemaining) return null;

  const clone = { ...classData, grades: {}, canvasGrades: {} };
  for (const cat of classData.categories) {
    const key = cat.name.toLowerCase();
    clone.grades[key] = merged[key]?.length > 0 ? [...merged[key]] : [100];
  }
  return calcCurrentGrade(clone);
}

const GPA_POINTS = {
  'A': 4.0, 'A-': 3.7,
  'B+': 3.3, 'B': 3.0, 'B-': 2.7,
  'C+': 2.3, 'C': 2.0, 'C-': 1.7,
  'D+': 1.3, 'D': 1.0, 'D-': 0.7,
  'F': 0.0,
};

/**
 * Calculate semester GPA across all classes.
 *
 * @returns {{
 *   gpa:      number|null,
 *   included: Array<{name, letter, gpaPoints, creditHours}>,
 *   missing:  string[],   // class names with grades but no credit hours set
 *   noGrades: string[],   // class names with no grades entered yet
 * }}
 */
export function calcGPA(classes) {
  const included = [];
  const missing = [];
  const noGrades = [];

  for (const classData of Object.values(classes)) {
    const result = calcCurrentGrade(classData);
    if (!result) { noGrades.push(classData.name); continue; }

    const letter = result.curvedLetter || getLetterGrade(result.curvedGrade);
    const gpaPoints = GPA_POINTS[letter];
    if (gpaPoints === undefined) continue;

    if (!classData.creditHours) { missing.push(classData.name); continue; }

    included.push({ name: classData.name, letter, gpaPoints, creditHours: classData.creditHours });
  }

  if (included.length === 0) return { gpa: null, included, missing, noGrades };

  const totalPoints = included.reduce((s, c) => s + c.gpaPoints * c.creditHours, 0);
  const totalHours  = included.reduce((s, c) => s + c.creditHours, 0);
  const gpa = Math.round((totalPoints / totalHours) * 100) / 100;

  return { gpa, included, missing, noGrades };
}

/**
 * Map a numeric percentage to a letter grade using standard cutoffs.
 */
export function getLetterGrade(pct) {
  if (pct >= 93) return 'A';
  if (pct >= 90) return 'A-';
  if (pct >= 87) return 'B+';
  if (pct >= 83) return 'B';
  if (pct >= 80) return 'B-';
  if (pct >= 77) return 'C+';
  if (pct >= 73) return 'C';
  if (pct >= 70) return 'C-';
  if (pct >= 67) return 'D+';
  if (pct >= 63) return 'D';
  if (pct >= 60) return 'D-';
  return 'F';
}
