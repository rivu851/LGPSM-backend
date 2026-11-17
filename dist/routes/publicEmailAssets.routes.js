"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const emailImages_1 = require("../services/email/emailImages");
// The small images used inside invitation emails (details icons, the LGPSM logo). Emails sent through an HTTPS mail service link to
// them here because such a service cannot embed an image by attachment. They are the same for every guest and hold no personal data.
const router = (0, express_1.Router)();
router.get('/:file', async (req, res) => {
    const cid = String(req.params.file || '').replace(/\.png$/i, '');
    const asset = /^[a-z0-9-]{1,60}$/i.test(cid) ? await (0, emailImages_1.emailAssetByCid)(cid) : null;
    if (!asset || !asset.content)
        return res.status(404).end();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).send(asset.content);
});
exports.default = router;
