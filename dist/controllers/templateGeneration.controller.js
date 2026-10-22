"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.templateGenerationController = void 0;
const designSpec_1 = require("../services/cardTemplates/designSpec");
const designSpec_2 = require("../services/cardTemplates/designSpec");
const templateGeneration_service_1 = require("../services/stitch/templateGeneration.service");
const stitch_provider_1 = require("../services/stitch/stitch.provider");
const env_1 = require("../config/env");
const template_validator_1 = require("../validators/template.validator");
const securityLog_1 = require("../utils/securityLog");
const actorOf = (req) => ({ userId: req.user.userId, role: req.user.role });
function fail(req, res, error) {
    if (error instanceof templateGeneration_service_1.GenerationError) {
        if (error.retryAfterSeconds)
            res.setHeader('Retry-After', String(error.retryAfterSeconds));
        if (error.code === 'JOB_NOT_FOUND' || error.code === 'VARIANT_NOT_FOUND')
            (0, securityLog_1.securityEvent)('TEMPLATE_GENERATION_DENIED', req, { code: error.code });
        return res.status(error.status).json({ success: false, code: error.code, message: error.message });
    }
    console.error('Request failed:', error?.message);
    return res.status(500).json({ success: false, code: 'INTERNAL', message: 'Something went wrong. Please try again.' });
}
exports.templateGenerationController = {
    // What the apps need to build the form, so web and mobile never hard-code sizes or limits
    async options(req, res) {
        const usage = await (0, templateGeneration_service_1.usageFor)(actorOf(req)).catch(() => null);
        return res.status(200).json({
            success: true,
            data: {
                available: (0, stitch_provider_1.getStitchProvider)().isConfigured(),
                presets: Object.entries(designSpec_1.CANVAS_PRESETS).map(([id, p]) => ({ id, kind: p.kind, width: p.width, height: p.height, label: p.label })),
                moods: template_validator_1.MOODS,
                limits: { promptMin: 10, promptMax: 800, changeMax: 500, maxVariants: 3, dailyQuota: env_1.env.STITCH_DAILY_QUOTA_PER_USER },
                fonts: designSpec_2.SPEC_FONTS,
                usage: usage ? (0, templateGeneration_service_1.serializeUsage)(usage) : undefined
            }
        });
    },
    async create(req, res) {
        try {
            const { job, deduplicated } = await templateGeneration_service_1.templateGenerationService.createJob(actorOf(req), req.body);
            return res.status(deduplicated ? 200 : 202).json({ success: true, deduplicated, data: (0, templateGeneration_service_1.serializeJob)(job), usage: (0, templateGeneration_service_1.serializeUsage)(await (0, templateGeneration_service_1.usageFor)(actorOf(req))) });
        }
        catch (error) {
            return fail(req, res, error);
        }
    },
    async list(req, res) {
        try {
            const page = req.query.page ? parseInt(req.query.page, 10) : undefined;
            const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
            const result = await templateGeneration_service_1.templateGenerationService.listJobs(actorOf(req), { page, limit });
            return res.status(200).json({ success: true, data: result.jobs.map(templateGeneration_service_1.serializeJob), meta: { page: result.page, limit: result.limit, total: result.total } });
        }
        catch (error) {
            return fail(req, res, error);
        }
    },
    async get(req, res) {
        try {
            const job = await templateGeneration_service_1.templateGenerationService.getJob(actorOf(req), req.params.id);
            return res.status(200).json({ success: true, data: (0, templateGeneration_service_1.serializeJob)(job) });
        }
        catch (error) {
            return fail(req, res, error);
        }
    },
    async remove(req, res) {
        try {
            await templateGeneration_service_1.templateGenerationService.deleteJob(actorOf(req), req.params.id);
            return res.status(200).json({ success: true, message: 'Generation deleted' });
        }
        catch (error) {
            return fail(req, res, error);
        }
    },
    async edit(req, res) {
        try {
            const { job, deduplicated } = await templateGeneration_service_1.templateGenerationService.editVariant(actorOf(req), req.params.id, Number(req.params.index), req.body.prompt, req.body.idempotencyKey);
            return res.status(deduplicated ? 200 : 202).json({ success: true, deduplicated, data: (0, templateGeneration_service_1.serializeJob)(job), usage: (0, templateGeneration_service_1.serializeUsage)(await (0, templateGeneration_service_1.usageFor)(actorOf(req))) });
        }
        catch (error) {
            return fail(req, res, error);
        }
    },
    async variations(req, res) {
        try {
            const { job, deduplicated } = await templateGeneration_service_1.templateGenerationService.createVariations(actorOf(req), req.params.id, Number(req.params.index), req.body.prompt, req.body.variantCount || 2, req.body.idempotencyKey);
            return res.status(deduplicated ? 200 : 202).json({ success: true, deduplicated, data: (0, templateGeneration_service_1.serializeJob)(job), usage: (0, templateGeneration_service_1.serializeUsage)(await (0, templateGeneration_service_1.usageFor)(actorOf(req))) });
        }
        catch (error) {
            return fail(req, res, error);
        }
    },
    async save(req, res) {
        try {
            const { template, alreadySaved } = await templateGeneration_service_1.templateGenerationService.saveVariant(actorOf(req), req.params.id, Number(req.params.index), req.body);
            return res.status(alreadySaved ? 200 : 201).json({ success: true, alreadySaved, data: template });
        }
        catch (error) {
            return fail(req, res, error);
        }
    }
};
