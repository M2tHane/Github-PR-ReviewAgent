ALTER TABLE memories
  ADD COLUMN level text NOT NULL DEFAULT 'should' CHECK (level IN ('must','should','info'));
