-- Apply as the database owner. Import the existing document before starting the gateway.
CREATE TABLE public.sitcon_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    -- Unlike jsonb, json stores the exact input text, including object order.
    document json NOT NULL CHECK (
        json_typeof(document) = 'object'
        AND json_typeof(document -> 'version') = 'number'
        AND (document ->> 'version') IS NOT DISTINCT FROM '1'
    ),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
