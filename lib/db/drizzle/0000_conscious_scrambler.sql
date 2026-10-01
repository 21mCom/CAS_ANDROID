CREATE TABLE "cas_app_updates" (
	"id" text PRIMARY KEY NOT NULL,
	"package_name" text NOT NULL,
	"version_code" integer NOT NULL,
	"version_name" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"uploaded_by_device_id" text,
	"uploaded_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cas_app_updates_version_code_unique" UNIQUE("version_code")
);
--> statement-breakpoint
CREATE TABLE "cas_auth_failure_streaks" (
	"ip" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"last_failure_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cas_capture_policy" (
	"id" text PRIMARY KEY NOT NULL,
	"audio" text DEFAULT 'off' NOT NULL,
	"photo" text DEFAULT 'off' NOT NULL,
	"video" text DEFAULT 'off' NOT NULL,
	"timing" text DEFAULT 'immediate' NOT NULL,
	"camera" text DEFAULT 'back' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cas_capture_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"detail" text,
	"via" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cas_device_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "cas_device_credentials_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "cas_email_accounts" (
	"slot" text PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"smtp_user" text NOT NULL,
	"password" text NOT NULL,
	"from_address" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cas_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"kind" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"captured_at" timestamp with time zone,
	"request_id" text,
	"sequence" integer DEFAULT 1 NOT NULL,
	"camera" text,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cas_gate_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"index" text NOT NULL,
	"name" text NOT NULL,
	"short" text NOT NULL,
	"status" text NOT NULL,
	"criterion" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_action" text NOT NULL,
	"owner" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cas_incident_events" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"type" text NOT NULL,
	"priority" text NOT NULL,
	"detail" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cas_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"priority" text NOT NULL,
	"status" text NOT NULL,
	"trigger_count" integer DEFAULT 1 NOT NULL,
	"location_latitude" double precision,
	"location_longitude" double precision,
	"location_accuracy_m" real,
	"location_captured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cas_message_templates" (
	"channel" text PRIMARY KEY NOT NULL,
	"body" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cas_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"transport" text NOT NULL,
	"state" text NOT NULL,
	"priority" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"device_cycle_token" text,
	"delivered_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cas_provider_deliveries" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"transport" text NOT NULL,
	"incident_id" text NOT NULL,
	"recipient_masked" text NOT NULL,
	"delivered_to" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cas_push_registrations" (
	"id" text PRIMARY KEY NOT NULL,
	"device_credential_id" text NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cas_push_registrations_device_credential_id_unique" UNIQUE("device_credential_id")
);
--> statement-breakpoint
CREATE TABLE "cas_responders" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sms_number" text,
	"whatsapp_number" text,
	"email_address" text,
	"xmpp_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cas_setup_readiness" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"detail" text NOT NULL,
	"group" text NOT NULL,
	"complete" boolean DEFAULT false NOT NULL,
	"mode" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cas_transport_cooldowns" (
	"transport" text PRIMARY KEY NOT NULL,
	"next_allowed_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cas_capture_requests" ADD CONSTRAINT "cas_capture_requests_incident_id_cas_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."cas_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cas_evidence" ADD CONSTRAINT "cas_evidence_incident_id_cas_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."cas_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cas_incident_events" ADD CONSTRAINT "cas_incident_events_incident_id_cas_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."cas_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cas_outbox" ADD CONSTRAINT "cas_outbox_incident_id_cas_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."cas_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cas_provider_deliveries" ADD CONSTRAINT "cas_provider_deliveries_incident_id_cas_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."cas_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cas_push_registrations" ADD CONSTRAINT "cas_push_registrations_device_credential_id_cas_device_credentials_id_fk" FOREIGN KEY ("device_credential_id") REFERENCES "public"."cas_device_credentials"("id") ON DELETE cascade ON UPDATE no action;