package teams

import (
	"encoding/base64"
	"encoding/json"
	"strings"

	"github.com/go-faster/errors"
)

// Claims holds the subset of JWT claims we care about. The token is never
// verified — we only inspect its payload to decide which audience it belongs
// to and when it expires. The token's authority is its bearer status, not its
// signature, so don't extend this to anything we'd treat as identity.
type Claims struct {
	Audience string `json:"aud"`
	TenantID string `json:"tid"`
	Issued   int64  `json:"iat"`
	Expires  int64  `json:"exp"`
	UPN      string `json:"upn"`
	Name     string `json:"name"`
}

func decodeClaims(token string) (*Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("not a JWT")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, errors.Wrap(err, "decode payload")
	}
	var c Claims
	if uerr := json.Unmarshal(payload, &c); uerr != nil {
		return nil, errors.Wrap(uerr, "unmarshal payload")
	}
	return &c, nil
}
