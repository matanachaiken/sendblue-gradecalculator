// canvas.ts — Canvas LMS API, scores only.
//
// Syllabus weights are the source of truth — this file never reads or uses
// Canvas assignment group weights. It only fetches graded scores so the
// bot can populate the categories that were parsed from the syllabus.
import axios from 'axios';
function normalizeUrl(url) {
    return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}
/**
 * Authenticated Canvas GET. Throws 'CANVAS_AUTH_ERROR' on 401.
 */
async function canvasGet(baseUrl, token, path, params = {}) {
    const url = `https://${normalizeUrl(baseUrl)}/api/v1${path}`;
    try {
        const res = await axios.get(url, {
            headers: { Authorization: `Bearer ${token}` },
            params: { per_page: 100, ...params },
            timeout: 15000,
        });
        return res.data;
    }
    catch (err) {
        const e = err;
        if (e.response?.status === 401)
            throw new Error('CANVAS_AUTH_ERROR');
        throw err;
    }
}
/**
 * Validate a token by listing active courses. Returns the course list.
 */
export async function getCourses(baseUrl, token) {
    const courses = await canvasGet(baseUrl, token, '/courses', {
        enrollment_type: 'student',
        enrollment_state: 'active,invited,completed',
        per_page: 50,
    });
    console.log('[canvas] courses returned:', courses.map(c => `${c.id}: ${c.name}`));
    return courses;
}
/**
 * Get every GRADED assignment for a course, with scores converted to percentages.
 * Canvas assignment group weights are intentionally ignored here — the caller
 * maps these scores to syllabus categories using batchMatchAssignments() in claude.ts.
 */
export async function getScoredAssignments(baseUrl, token, courseId) {
    // Fetch groups (for group names, used as matching hints) and assignments in parallel
    const [groups, assignments] = await Promise.all([
        canvasGet(baseUrl, token, `/courses/${courseId}/assignment_groups`),
        canvasGet(baseUrl, token, `/courses/${courseId}/assignments`, { include: ['submission'] }),
    ]);
    const groupNames = Object.fromEntries(groups.map(g => [g.id, g.name]));
    const result = [];
    for (const a of assignments) {
        // Skip assignments that can't have a meaningful percentage score
        if (!a.points_possible || a.points_possible === 0)
            continue;
        const sub = a.submission;
        const isGraded = sub &&
            sub.workflow_state === 'graded' &&
            sub.score !== null &&
            sub.score !== undefined;
        if (!isGraded)
            continue;
        result.push({
            id: String(a.id),
            name: a.name,
            groupName: groupNames[a.assignment_group_id] || 'Uncategorized',
            percentage: Math.round((sub.score / a.points_possible) * 1000) / 10,
        });
    }
    return result;
}
