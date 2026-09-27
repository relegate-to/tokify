package models

import (
	"time"
)

type StartActivityRequest struct {
	Description string
	Project     string
	StartTime   time.Time
	Notes       string
	Tags        []string
}

type StopActivityRequest struct {
	EndTime time.Time
	Notes   string
	Tags    []string
}

type AddActivityRequest struct {
	Description string
	Project     string
	StartTime   time.Time
	EndTime     time.Time
	Notes       string
	Tags        []string
}

type ActivityFilter struct {
	FromDate    *time.Time
	ToDate      *time.Time
	Project     *string
	Description *string
	IsRunning   *bool
}

type Report struct {
	Activities    []Activity
	TotalDuration time.Duration
	ByProject     map[string]ProjectReport
}

type ProjectReport struct {
	ProjectName string
	Duration    time.Duration
	Activities  []Activity
}

// ActivityChange describes the state of one activity slot before and after a
// mutation. A nil side means the slot did not exist. When both sides are set,
// their start times must match; moving an activity is represented by a delete
// at the old start and a create at the new start.
type ActivityChange struct {
	Before *Activity
	After  *Activity
}
