import { type BindRequestPayload, type ProposeRequestPayload } from "@a2api/protocol";
export interface BootstrapPlan {
    kind: "list_moments" | "list_users" | "list_comments" | "create_moment" | "update_comment" | "delete_comment" | "unknown";
    title: string;
    propose: ProposeRequestPayload;
    bind?: BindRequestPayload;
    a2uiHint: {
        surfaceId: string;
        filters: Array<{
            key: string;
            label: string;
            type: "text" | "number" | "select";
            options?: string[];
        }>;
    };
    /** Optional write fields for forms */
    writeForm?: {
        fields: Array<{
            key: string;
            label: string;
            path: string;
        }>;
    };
}
export declare function planFromIntent(message: string): BootstrapPlan;
export declare function toProposeEnvelope(propose: ProposeRequestPayload): {
    version: "0.1";
    proposeRequest: ProposeRequestPayload;
};
export declare function toBindEnvelope(bind: BindRequestPayload): {
    version: "0.1";
    bindRequest: BindRequestPayload;
};
//# sourceMappingURL=intent.d.ts.map