/**
 * Course Creator — agent-assisted micro-lesson generation (ZSA10 Extension)
 *
 * Turns Farmyard decision records into draft micro-lessons the farmer can
 * review, edit and publish to the micro-learning registry (which feeds the
 * website + dashboard marketplace).
 *
 * Flow (per COURSE-CREATOR.md):
 *   1. teachable-moments — scan recent decisions (executed/denied/completed),
 *      score each for lesson potential from outcome, sentiment and rationale.
 *   2. draft-lesson      — LLM (OpenRouter, same pattern as course-teacher.js)
 *      drafts the registry-shaped lesson from the decision record.
 *   3. publish           — privacy-checked lesson POSTed to the dashboard's
 *      micro-learning registry writer (DASHBOARD_API_URL →
 *      /api/microlearning/publish) or written directly when
 *      MICROLEARNING_REGISTRY_PATH points at a local file.
 *   4. engagement        — tracked in a local store; bumped by the registry's
 *      view/complete/feedback events until a cross-farm analytics feed exists.
 *
 * Env vars:
 *   FARMYARD_API_URL            — Farmyard Unified API base (default http://localhost:8000)
 *   DASHBOARD_API_URL           — dashboard backend base, no /api suffix
 *                                 (registry writer lives there)
 *   MICROLEARNING_REGISTRY_PATH — optional direct file write fallback
 *   COURSE_CREATOR_ENABLED      — 'false' to disable (default enabled)
 *   OPENROUTER_API_KEY / OPENROUTER_MODEL — LLM for drafting
 */

'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const FARMYARD_URL = process.env.FARMYARD_API_URL || 'http://localhost:8000';
const DASHBOARD_URL = (process.env.DASHBOARD_API_URL || process.env.DASHBOARD_URL || '').replace(/\/$/, '');
const REGISTRY_PATH = process.env.MICROLEARNING_REGISTRY_PATH || null;
const ENABLED = (process.env.COURSE_CREATOR_ENABLED || 'true') !== 'false';

const ENGAGEMENT_FILE = process.env.COURSE_ENGAGEMENT_FILE
    || path.join(__dirname, '..', '..', 'data', 'course-engagement.json');

const LESSON_SYSTEM_PROMPT = `You are Red Dog — an Aussie farm dog agent that turns real farm decisions into micro-lessons for the Agentic Ag network.
Given a farm decision record (what was recommended, what the farmer decided, their reason, and the scored sentiment), draft ONE micro-lesson.

Rules:
- Write for other farmers: practical, plain language, no fluff.
- NEVER include operator names, exact coordinates, or raw sensor dumps — region-level context only.
- Denied decisions are valuable lessons too — frame them as "why we didn't and what happened".

Respond with valid JSON only:
{
  "title": "Lesson title — specific and searchable",
  "summary": "1-2 sentence summary",
  "context": { "region": "...", "crop": "...", "season": "...", "industry": "..." },
  "what_happened": "What triggered the decision and what was recommended",
  "decision_made": "What the farmer decided and their stated reason (paraphrased, no names)",
  "outcome": "What happened after — or 'pending' if unknown",
  "what_we_learned": ["3-5 takeaways"],
  "how_to_apply": ["3-5 actionable steps another farmer could follow"],
  "tags": ["industry/topic tags"],
  "level": "Beginner | Intermediate | Advanced",
  "duration": "e.g. 8 min"
}`;

class CourseCreator {
    /**
     * @param {object} opts
     * @param {import('./ai-engine')} [opts.aiEngine] - Red Dog AI engine
     * @param {string} [opts.apiKey] - OpenRouter key (default env)
     * @param {string} [opts.model] - OpenRouter model (default env / gpt-4o-mini)
     */
    constructor({ aiEngine, apiKey, model } = {}) {
        this.aiEngine = aiEngine || null;
        this.apiKey = apiKey || process.env.OPENROUTER_API_KEY;
        this.model = model || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
        this.farmId = process.env.FARM_ID || 'unknown-farm';
        this._engagement = this._loadEngagement();
    }

    get enabled() {
        return ENABLED;
    }

    // ── Teachable moments ──────────────────────────────────────────────────

    /**
     * Pull recent decisions from Farmyard and score each for lesson potential.
     * @returns {{moments: Array, source: string, error?: string}}
     */
    async listTeachableMoments({ limit = 50, domain, status } = {}) {
        const params = new URLSearchParams({ limit: String(limit) });
        if (domain) params.set('domain', domain);
        if (status) params.set('status', status);

        let decisions;
        try {
            const res = await axios.get(`${FARMYARD_URL}/api/v1/decisions?${params}`, { timeout: 8000 });
            decisions = res.data?.decisions || [];
        } catch (err) {
            console.warn('[CourseCreator] Farmyard unreachable:', err.message);
            return { moments: [], source: 'farmyard', error: err.message };
        }

        const moments = decisions
            .filter(d => d.decision !== 'pending')
            .map(d => this._scoreMoment(d))
            .filter(m => m.lesson_potential !== 'none')
            .sort((a, b) => this._rank(b) - this._rank(a));

        return { moments, source: 'farmyard', farm: this.farmId };
    }

    _scoreMoment(d) {
        const sentimentScore = d.sentiment?.score ?? null;
        const hasRationale = !!(d.rationale || d.reason_category);
        const isAdvisory = d.source && d.source !== 'agent';
        const decided = d.decision === 'executed' || d.decision === 'completed';
        const denied = d.decision === 'denied';

        let potential, framing;
        if (denied && hasRationale) {
            potential = 'high'; framing = 'what_went_wrong_or_why_denied';
        } else if (denied) {
            potential = 'medium'; framing = 'why_denied';
        } else if (decided && sentimentScore !== null && sentimentScore < -0.2) {
            potential = 'high'; framing = 'what_went_wrong';
        } else if (decided && sentimentScore !== null && sentimentScore > 0.3) {
            potential = 'high'; framing = 'what_worked_well';
        } else if (decided) {
            potential = 'medium'; framing = 'how_we_did_it';
        } else {
            potential = 'low'; framing = 'what_we_tried';
        }

        if (isAdvisory && potential !== 'high') potential = 'high'; // adoption of external advice is always interesting
        if (potential === 'low' && !hasRationale) potential = 'none';

        return {
            teachable_moment_id: `tm-${d.decision_id}`,
            decision_id: d.decision_id,
            title: d.action_label || d.summary || `Decision ${d.decision_id}`,
            summary: d.summary,
            domain: d.domain,
            status: d.decision,
            source: d.source || 'agent',
            source_ref: d.source_ref || null,
            reason_category: d.reason_category || null,
            sentiment: d.sentiment || null,
            decided_at: d.decided_at || null,
            lesson_potential: potential,
            framing
        };
    }

    _rank(m) {
        return { high: 3, medium: 2, low: 1, none: 0 }[m.lesson_potential] || 0;
    }

    // ── Lesson drafting ────────────────────────────────────────────────────

    /**
     * Draft a registry-shaped lesson from a teachable moment / decision id.
     * Falls back to a templated lesson if no LLM is reachable.
     */
    async draftLesson({ teachable_moment_id, decision_id, decision } = {}) {
        const decisionId = decision_id
            || (teachable_moment_id || '').replace(/^tm-/, '')
            || decision?.decision_id;
        if (!decisionId && !decision) throw new Error('teachable_moment_id, decision_id or decision required');

        const record = decision || await this._fetchDecision(decisionId);
        if (!record) throw new Error(`Decision '${decisionId}' not found`);

        const draft = await this._llmDraft(record);
        return {
            draft,
            source_decision: {
                decision_id: record.decision_id,
                status: record.decision,
                domain: record.domain,
                source: record.source
            }
        };
    }

    async _fetchDecision(decisionId) {
        try {
            const res = await axios.get(`${FARMYARD_URL}/api/v1/decisions?limit=200`, { timeout: 8000 });
            return (res.data?.decisions || []).find(d => d.decision_id === decisionId) || null;
        } catch (err) {
            console.warn('[CourseCreator] Farmyard fetch failed:', err.message);
            return null;
        }
    }

    async _llmDraft(record) {
        // Privacy: never send raw operator identity or gateway detail to the LLM.
        const safe = {
            summary: record.summary,
            action_label: record.action_label,
            domain: record.domain,
            status: record.decision,
            source: record.source,
            reason_category: record.reason_category,
            rationale_theme: record.rationale ? 'farmer gave a reason' : null,
            sentiment: record.sentiment || null,
            data_types: record.data_types,
            record_count: record.record_count,
            timestamp: record.timestamp
        };

        if (!this.apiKey) {
            console.warn('[CourseCreator] No OPENROUTER_API_KEY — returning template draft');
            return this._templateDraft(record);
        }

        try {
            const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                model: this.model,
                messages: [
                    { role: 'system', content: LESSON_SYSTEM_PROMPT },
                    { role: 'user', content: `Decision record:\n${JSON.stringify(safe, null, 2)}` }
                ],
                response_format: { type: 'json_object' }
            }, {
                headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
                timeout: 30000
            });

            const raw = res.data.choices[0].message.content;
            try {
                return JSON.parse(raw);
            } catch {
                const match = raw.match(/\{[\s\S]*\}/);
                return match ? JSON.parse(match[0]) : this._templateDraft(record);
            }
        } catch (err) {
            console.warn('[CourseCreator] LLM draft failed, using template:', err.message);
            return this._templateDraft(record);
        }
    }

    _templateDraft(record) {
        const status = record.decision || 'decided';
        const title = record.action_label || record.summary || `Farm decision ${record.decision_id}`;
        return {
            title: `${title} — ${record.domain || 'farm'} lesson`,
            summary: `A ${record.domain || 'farm'} decision (${status}) captured from the activity log${record.reason_category ? ` — reason: ${record.reason_category}` : ''}.`,
            context: { region: '', crop: '', season: '', industry: record.domain || '' },
            what_happened: record.summary || '',
            decision_made: `Decision ${status}${record.reason_category ? ` (${record.reason_category})` : ''}.`,
            outcome: record.sentiment ? `Sentiment after: ${JSON.stringify(record.sentiment.score)}` : 'pending',
            what_we_learned: [],
            how_to_apply: [],
            tags: [record.domain, status, record.reason_category].filter(Boolean),
            level: 'Intermediate',
            duration: '8 min'
        };
    }

    // ── Publishing ─────────────────────────────────────────────────────────

    /**
     * Validate + publish a lesson to the micro-learning registry.
     * Preferred path: POST to the dashboard's registry writer. Fallback:
     * direct file write when MICROLEARNING_REGISTRY_PATH is set (local dev /
     * same-host deployments).
     */
    async publishLesson({ lesson, audience = 'network', price = 0, author_id } = {}) {
        if (!lesson || !lesson.title) throw new Error('lesson.title required');

        const entry = this._toRegistryEntry(lesson, { audience, price, author_id });
        const privacyIssues = this._privacyCheck(entry);
        if (privacyIssues.length) {
            return { published: false, blocked: true, issues: privacyIssues };
        }

        if (DASHBOARD_URL) {
            const res = await axios.post(`${DASHBOARD_URL}/api/microlearning/publish`,
                { lesson: entry, audience, price, author_id },
                { timeout: 10000 });
            return { published: true, lesson_id: entry.id, via: 'dashboard', ...res.data };
        }

        if (REGISTRY_PATH) {
            const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
            registry.courses = registry.courses || [];
            if (registry.courses.some(c => c.id === entry.id)) {
                throw new Error(`Lesson id '${entry.id}' already exists in registry`);
            }
            registry.courses.push(entry);
            registry.last_updated = new Date().toISOString().slice(0, 10);
            registry.stats = this._recountStats(registry.courses);
            const tmp = `${REGISTRY_PATH}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(registry, null, 2));
            fs.renameSync(tmp, REGISTRY_PATH);
            return { published: true, lesson_id: entry.id, via: 'file' };
        }

        throw new Error('No publish path configured — set DASHBOARD_API_URL (registry writer) or MICROLEARNING_REGISTRY_PATH (direct file)');
    }

    _toRegistryEntry(lesson, { audience, price, author_id }) {
        const id = lesson.id || this._slugify(lesson.title);
        const learned = (lesson.what_we_learned || []).map(s => `  • ${s}`);
        const apply = (lesson.how_to_apply || []).map(s => `  • ${s}`);
        const details = [
            `What happened: ${lesson.what_happened || ''}`,
            `Decision made: ${lesson.decision_made || ''}`,
            `Outcome: ${lesson.outcome || ''}`,
            learned.length ? 'What we learned:' : null, ...learned,
            apply.length ? 'How to apply it:' : null, ...apply
        ].filter(Boolean);

        return {
            id,
            title: lesson.title,
            description: lesson.summary || '',
            duration: lesson.duration || '10 min',
            level: lesson.level || 'Intermediate',
            total_lessons: 1,
            modules: 1,
            price: Number(price) || 0,
            image: lesson.image || 'images/courses/agenticag-how-to.png',
            author_type: lesson.author_type || 'farmer',
            author: author_id
                ? `Red Dog + ${author_id}`
                : `Red Dog (from ${this.farmId} activity log)`,
            industries: [lesson.context?.industry].filter(Boolean).length
                ? [lesson.context.industry] : ['all'],
            audience,
            tags: lesson.tags || [],
            context: lesson.context || {},
            details
        };
    }

    _privacyCheck(entry) {
        const issues = [];
        const text = JSON.stringify(entry);
        if (/\b\d{2,3}\.\d{4,}\b/.test(text)) issues.push('possible precise coordinates detected');
        if (entry.context?.farm && entry.context.farm.length > 30) {
            issues.push('context.farm looks like a precise identifier — use region only');
        }
        for (const bad of ['decided_by', 'rationale', 'gateways', 'password', 'token']) {
            if (bad in entry) issues.push(`private field '${bad}' present in entry`);
        }
        return issues;
    }

    _recountStats(courses) {
        return {
            total_courses: courses.length,
            platform_courses: courses.filter(c => c.author_type === 'platform').length,
            agent_generated: courses.filter(c => ['agent', 'farmer'].includes(c.author_type)).length,
            industry_contributed: courses.filter(c => c.author_type === 'industry').length,
            free_courses: courses.filter(c => !c.price).length,
            paid_courses: courses.filter(c => c.price > 0).length,
            industries_covered: [...new Set(courses.flatMap(c => c.industries || ['all']))]
        };
    }

    _slugify(text) {
        const base = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
        return `${base}-${Date.now().toString(36)}`;
    }

    // ── Engagement tracking ────────────────────────────────────────────────

    _loadEngagement() {
        try { return JSON.parse(fs.readFileSync(ENGAGEMENT_FILE, 'utf-8')); }
        catch { return {}; }
    }

    _saveEngagement() {
        try {
            fs.mkdirSync(path.dirname(ENGAGEMENT_FILE), { recursive: true });
            fs.writeFileSync(ENGAGEMENT_FILE, JSON.stringify(this._engagement, null, 2));
        } catch (err) {
            console.warn('[CourseCreator] Engagement save failed:', err.message);
        }
    }

    /** Record an engagement event (view | complete | feedback | applied). */
    trackEngagement(lessonId, event, meta = {}) {
        const e = this._engagement[lessonId] ||= { views: 0, completions: 0, feedback: [], applications: 0 };
        if (event === 'view') e.views++;
        else if (event === 'complete') e.completions++;
        else if (event === 'applied') e.applications++;
        else if (event === 'feedback') e.feedback.push({ sentiment: meta.sentiment ?? null, at: new Date().toISOString() });
        e.updated_at = new Date().toISOString();
        this._saveEngagement();
        return e;
    }

    getEngagement(lessonId) {
        const e = this._engagement[lessonId];
        if (!e) return { lesson_id: lessonId, views: 0, completions: 0, feedback: [], applications: 0, credits: 0 };
        // Credits per COURSE-CREATOR.md table
        const credits =
            Math.floor(e.views / 10) * 5 +
            Math.floor(e.completions / 10) * 20 +
            e.feedback.filter(f => (f.sentiment ?? 0) > 0).length * 3 +
            e.applications * 10;
        return { lesson_id: lessonId, ...e, credits };
    }
}

module.exports = CourseCreator;
