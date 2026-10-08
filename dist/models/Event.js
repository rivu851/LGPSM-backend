"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Event = exports.EventStatus = exports.EventFormat = void 0;
const mongoose_1 = __importStar(require("mongoose"));
var EventFormat;
(function (EventFormat) {
    EventFormat["PHYSICAL"] = "PHYSICAL";
    EventFormat["VIRTUAL"] = "VIRTUAL";
})(EventFormat || (exports.EventFormat = EventFormat = {}));
var EventStatus;
(function (EventStatus) {
    EventStatus["DRAFT"] = "DRAFT";
    EventStatus["PUBLISHED"] = "PUBLISHED";
    EventStatus["COMPLETED"] = "COMPLETED";
    EventStatus["CANCELLED"] = "CANCELLED";
})(EventStatus || (exports.EventStatus = EventStatus = {}));
const EventSchema = new mongoose_1.Schema({
    organizerId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, maxlength: 100 },
    description: { type: String, required: true },
    categoryId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Category', required: true },
    subcategoryId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Category' },
    format: { type: String, enum: Object.values(EventFormat), required: true },
    location: {
        address: { type: String },
        coordinates: {
            type: { type: String, enum: ['Point'], required: false },
            coordinates: { type: [Number], required: false } // [longitude, latitude]
        }
    },
    contactNumber: { type: String },
    schedule: {
        start: { type: Date, required: true },
        end: { type: Date, required: true }
    },
    rsvp: {
        enabled: { type: Boolean, required: true, default: false },
        acceptanceLastDate: { type: Date },
        allowAllInvited: { type: Boolean, required: true, default: true },
        allowNotResponded: { type: Boolean, required: true, default: false },
        allowDeclined: { type: Boolean, required: true, default: false }
    },
    attendeeSettings: {
        thresholdLimit: { type: Number }
    },
    dietaryPreference: {
        enabled: { type: Boolean, required: true, default: false },
        title: { type: String },
        options: { type: [mongoose_1.Schema.Types.Mixed], default: [] }
    },
    templateId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Template' },
    media: {
        logoKey: { type: String },
        bannerKey: { type: String }
    },
    status: { type: String, enum: Object.values(EventStatus), default: EventStatus.DRAFT, required: true },
    pricing: {
        ratePerInvitee: { type: Number, default: null },
        currency: { type: String },
        lockedAt: { type: Date }
    },
    operationalDataCleared: { type: Boolean, default: false }
}, {
    timestamps: true
});
// Indexes
EventSchema.index({ organizerId: 1 });
EventSchema.index({ status: 1 });
EventSchema.index({ categoryId: 1 });
EventSchema.index({ 'schedule.start': 1 });
EventSchema.index({ 'location.coordinates': '2dsphere' });
exports.Event = mongoose_1.default.model('Event', EventSchema);
