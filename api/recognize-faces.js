// Face recognition is NOT implemented yet — there is no computer-vision /
// face-matching backend connected. This endpoint exists so the app has a
// stable, honest contract to call today ("who's here?" -> a clear "not set
// up yet" answer, never a guess), and so a real matching service can be
// dropped in later without changing the frontend or the voice command
// wiring that calls this endpoint.
//
// Real implementation, when ready, would likely:
//   1. Take each registered person's stored reference photos (saved during
//      onboarding as base64 in that person's `photos` array) and
//      pre-compute a face embedding per person once, rather than
//      re-processing their photos on every "who's here?" call.
//   2. Detect any faces in the incoming camera frame and compute an
//      embedding for each detected face using the same model/service.
//   3. Compare detected-face embeddings against each registered person's
//      stored embedding(s), and only return a match above a deliberately
//      conservative confidence threshold — this app must never guess at
//      someone's identity.
//   4. Return unmatched detected faces as an anonymous "a person is
//      present" rather than dropping them, so this stays useful even for
//      people who aren't registered.
//
// Candidate real services: AWS Rekognition (IndexFaces + SearchFacesByImage
// or CompareFaces), or a dedicated face-embedding model via
// Bedrock/SageMaker. None of that is wired up yet — this file intentionally
// does no image analysis of any kind.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // image: base64 jpeg of the current camera frame (kept in the request
    //        contract now so a real implementation doesn't need a wiring
    //        change on the frontend later).
    // registeredFaces: [{ name, relationship }, ...] — the person's saved
    //        familiar-faces list. Accepted and validated now for the same
    //        forward-compatibility reason; unused by this stub.
    const { image, registeredFaces } = req.body || {};

    if (!image) {
      return res.status(400).json({ error: 'Missing image data' });
    }

    const faces = Array.isArray(registeredFaces) ? registeredFaces : [];

    return res.status(200).json({
      status: 'not_configured',
      recognized: [],
      registeredCount: faces.length,
      message: 'Face recognition is not connected to a real matching service yet.'
    });

  } catch (err) {
    console.error('recognize-faces error:', err);
    return res.status(500).json({ error: 'Could not check for familiar faces' });
  }
}
