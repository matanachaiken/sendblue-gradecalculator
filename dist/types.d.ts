export type CurveType = 'flat' | 'mean' | 'norm' | 'none';
export interface Category {
    name: string;
    weight: number;
    dropLowest?: number;
}
export interface DynamicWeights {
    type: 'best_worst';
    categoryA: string;
    categoryB: string;
    bestWeight: number;
    worstWeight: number;
}
export interface Curve {
    type: CurveType;
    flatPoints?: number;
    targetMean?: number | null;
    classAvg?: number | null;
    median?: number | null;
    mappedGrade?: string | null;
}
export interface ClassData {
    name: string;
    categories: Category[];
    grades: Record<string, number[]>;
    canvasGrades?: Record<string, number[]>;
    classAverages?: Record<string, number>;
    curve: Curve;
    dynamicWeights?: DynamicWeights | null;
    canvasSynced?: boolean;
    canvasId?: number | null;
    canvasAssignmentMap?: Record<string, string | null>;
    creditHours?: number;
    lastSyncedAt?: string;
}
export interface UserState {
    step: string;
    pendingClass: string | null;
    pendingRestart?: boolean;
    pendingConfirmation?: PendingConfirmation;
}
export interface PendingConfirmation {
    type: string;
    data: Record<string, unknown>;
    question: string;
}
export interface Config {
    canvasSetupAsked: boolean;
    canvasConnected: boolean;
}
export interface StorageData {
    classes: Record<string, ClassData>;
    userStates: Record<string, UserState>;
    config: Config;
    lastAction?: LastAction;
}
export type LastAction = {
    type: 'grade_saved';
    classKey: string;
    className: string;
    catKey: string;
    catDisplay: string;
    score: number;
    previousGrades: number[];
    timestamp: string;
} | {
    type: 'grade_deleted';
    classKey: string;
    className: string;
    catKey: string;
    catDisplay: string;
    removedScore: number;
    previousGrades: number[];
    timestamp: string;
} | {
    type: 'class_average_saved';
    classKey: string;
    className: string;
    field: string;
    previousValue: number | null;
    newValue: number;
    label: string;
    timestamp: string;
} | {
    type: 'norm_grade_saved';
    classKey: string;
    className: string;
    previousValue: string | null;
    newValue: string;
    timestamp: string;
} | {
    type: 'class_added';
    classKey: string;
    className: string;
    timestamp: string;
} | {
    type: 'syllabus_updated';
    classKey: string;
    className: string;
    previousClassData: ClassData;
    timestamp: string;
} | {
    type: 'canvas_linked';
    classKey: string;
    className: string;
    previousClassData: ClassData;
    timestamp: string;
};
export type Intent = {
    action: 'new_class';
    className: string;
} | {
    action: 'enter_grade';
    classKey: string | null;
    categoryName: string;
    score: number;
    _batchMode?: boolean;
} | {
    action: 'enter_class_average';
    classKey: string | null;
    categoryName?: string;
    average: number;
    _batchMode?: boolean;
} | {
    action: 'check_grade';
    classKey: string | null;
} | {
    action: 'show_all';
} | {
    action: 'delete_class';
    classKey: string;
} | {
    action: 'sync_canvas';
} | {
    action: 'connect_canvas';
} | {
    action: 'update_syllabus';
    classKey: string;
} | {
    action: 'help';
} | {
    action: 'reset';
} | {
    action: 'undo';
} | {
    action: 'enter_manually';
    classKey: string | null;
} | {
    action: 'show_gpa';
} | {
    action: 'set_credits';
    classKey: string;
    credits: number;
} | {
    action: 'hypothetical_grade';
    classKey: string;
    categoryName: string;
    score: number;
} | {
    action: 'delete_grade';
    classKey: string;
    categoryName: string;
    score?: number;
} | {
    action: 'set_norm_letter';
    classKey: string | null;
    letter: string | null;
} | {
    action: 'confirm';
    guess: string;
    confirmedIntent: Intent;
} | {
    action: 'multi';
    intents: Intent[];
} | {
    action: 'unknown';
};
export interface CanvasCourse {
    id: number;
    name: string;
    [key: string]: unknown;
}
export interface CanvasAssignment {
    id: string;
    name: string;
    groupName: string;
    percentage: number;
}
export interface ParsedSyllabus {
    categories: Category[];
    dynamicWeights?: DynamicWeights | null;
    notes?: string;
}
export interface AssignmentMatch {
    catKey: string | null;
    confident: boolean;
}
export interface BreakdownItem {
    name: string;
    weight: number;
    rawAvg: number;
    count: number;
    droppedCount: number;
    weightNote: string | null;
}
export interface CurveResult {
    curvedGrade: number;
    curvedLetter: string | null;
    pending: boolean;
    noShift?: boolean;
    note: string;
}
export interface GradeResult {
    rawGrade: number;
    curvedGrade: number;
    curvedLetter: string | null;
    curvePending: boolean;
    curveNoShift: boolean;
    curveNote: string;
    completedWeight: number;
    breakdown: BreakdownItem[];
}
export interface GpaEntry {
    name: string;
    letter: string;
    gpaPoints: number;
    creditHours: number;
}
export interface GpaResult {
    gpa: number | null;
    included: GpaEntry[];
    missing: string[];
    noGrades: string[];
}
export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type LastActionInput = DistributiveOmit<LastAction, 'timestamp'>;
