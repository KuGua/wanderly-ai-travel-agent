DROP TRIGGER IF EXISTS personal_research_requests_immutable ON personal_research_requests;
CREATE TRIGGER personal_research_requests_immutable
  BEFORE UPDATE ON personal_research_requests
  FOR EACH ROW EXECUTE FUNCTION reject_personal_research_request_mutation();
