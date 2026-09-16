CREATE TRIGGER `log_no_update` BEFORE UPDATE ON `log`
BEGIN
  SELECT RAISE(ABORT, 'log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `log_no_delete` BEFORE DELETE ON `log`
BEGIN
  SELECT RAISE(ABORT, 'log is append-only');
END;
