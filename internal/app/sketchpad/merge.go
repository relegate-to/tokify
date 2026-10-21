package sketchpad

import (
	"slices"
	"strings"
)

// Merge combines two edits of the sketchpad made from a common base: ours and
// theirs. Edits to different blocks both apply. Where the two touched the same
// blocks, ours stands and the blocks only theirs wrote are added after it, so a
// conflict can duplicate text but never drops what either device wrote.
func Merge(base, ours, theirs string) string {
	switch {
	case ours == theirs, theirs == base:
		return ours
	case ours == base:
		return theirs
	}
	b, o, t := lines(base), lines(ours), lines(theirs)
	return render(merge3(b, o, t))
}

// The pad is merged as a list of lines, one per leaf block (a paragraph,
// heading, project marker and so on), each carrying the containers around it:
// lists, list items and their wrappers. A container's opening tag is written in
// full on the line that opens it and as its bare name on the lines after, so
// ticking a to-do changes only that to-do's own line. Any sequence of lines
// renders to well-formed HTML, which is what lets a conflict keep both sides.
const (
	levelSep = "\x00"
	leafSep  = "\x01"
	opened   = "+"
)

func isContainer(name string) bool {
	switch name {
	case "ul", "ol", "li", "blockquote", "div":
		return true
	}
	return false
}

func isVoid(name string) bool {
	switch name {
	case "br", "hr", "img", "input", "wbr":
		return true
	}
	return false
}

func lines(html string) []string {
	var out []string
	var path []string // each level: opened+full tag, or the bare tag name
	var stack []string
	var fresh []bool // levels of path opened since the last leaf
	for i := 0; i < len(html); {
		if html[i] != '<' {
			j := strings.IndexByte(html[i:], '<')
			if j < 0 {
				j = len(html) - i
			}
			out = append(out, line(path, fresh, html[i:i+j]))
			clear(fresh)
			i += j
			continue
		}
		end := tagEnd(html, i)
		tag := html[i:end]
		name, closing := tagName(tag)
		switch {
		case closing && isContainer(name):
			if n := len(stack); n > 0 && stack[n-1] == name {
				stack = stack[:n-1]
				path = path[:n-1]
				fresh = fresh[:n-1]
			}
			i = end
		case !closing && isContainer(name):
			head := tag
			i = end
			if name == "li" && strings.HasPrefix(html[i:], "<label") {
				stop := closeOf(html, tagEnd(html, i), "label")
				head += html[i:stop]
				i = stop
			}
			stack = append(stack, name)
			path = append(path, head)
			fresh = append(fresh, true)
		default:
			stop := end
			if !closing && !isVoid(name) && !strings.HasSuffix(tag, "/>") {
				stop = closeOf(html, end, name)
			}
			out = append(out, line(path, fresh, html[i:stop]))
			clear(fresh)
			i = stop
		}
	}
	return out
}

// line encodes a leaf with its containers, marking those that open here.
func line(path []string, fresh []bool, leaf string) string {
	var b strings.Builder
	for i, head := range path {
		if fresh[i] {
			b.WriteString(opened + head)
		} else {
			name, _ := tagName(head)
			b.WriteString(name)
		}
		b.WriteString(levelSep)
	}
	b.WriteString(leafSep + leaf)
	return b.String()
}

func render(ls []string) string {
	var b strings.Builder
	var stack []string // open container names
	for _, l := range ls {
		levels, leaf, _ := strings.Cut(l, leafSep)
		var path []string
		if levels != "" {
			path = strings.Split(strings.TrimSuffix(levels, levelSep), levelSep)
		}
		keep := 0
		for keep < len(path) && keep < len(stack) && !strings.HasPrefix(path[keep], opened) && path[keep] == stack[keep] {
			keep++
		}
		for len(stack) > keep {
			b.WriteString("</" + stack[len(stack)-1] + ">")
			stack = stack[:len(stack)-1]
		}
		for _, level := range path[keep:] {
			head, full := strings.CutPrefix(level, opened)
			name := head
			if full {
				name, _ = tagName(head)
			} else {
				head = "<" + name + ">"
			}
			b.WriteString(head)
			stack = append(stack, name)
		}
		b.WriteString(leaf)
	}
	for len(stack) > 0 {
		b.WriteString("</" + stack[len(stack)-1] + ">")
		stack = stack[:len(stack)-1]
	}
	return b.String()
}

// tagEnd returns the index just past the tag starting at i, skipping quoted
// attribute values.
func tagEnd(s string, i int) int {
	var quote byte
	for j := i + 1; j < len(s); j++ {
		switch c := s[j]; {
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case c == '"' || c == '\'':
			quote = c
		case c == '>':
			return j + 1
		}
	}
	return len(s)
}

func tagName(tag string) (string, bool) {
	s := strings.TrimPrefix(tag, "<")
	closing := strings.HasPrefix(s, "/")
	s = strings.TrimPrefix(s, "/")
	end := strings.IndexFunc(s, func(r rune) bool {
		return (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '-'
	})
	if end < 0 {
		end = len(s)
	}
	return strings.ToLower(s[:end]), closing
}

// closeOf returns the index just past the tag closing an element named name
// whose content starts at from, counting nested elements of the same name.
func closeOf(s string, from int, name string) int {
	depth := 1
	for i := from; i < len(s); {
		j := strings.IndexByte(s[i:], '<')
		if j < 0 {
			break
		}
		i += j
		end := tagEnd(s, i)
		n, closing := tagName(s[i:end])
		if n == name {
			if closing {
				depth--
			} else if !strings.HasSuffix(s[i:end], "/>") {
				depth++
			}
			if depth == 0 {
				return end
			}
		}
		i = end
	}
	return len(s)
}

// hunk replaces base[b0:b1] with side[s0:s1].
type hunk struct {
	b0, b1, s0, s1 int
	theirs         bool
}

func merge3(base, ours, theirs []string) []string {
	hs := append(diff(base, ours, false), diff(base, theirs, true)...)
	slices.SortStableFunc(hs, func(a, b hunk) int {
		if a.b0 != b.b0 {
			return a.b0 - b.b0
		}
		// An insertion goes before a change starting at the same place.
		return min(a.b1-a.b0, 1) - min(b.b1-b.b0, 1)
	})

	var out []string
	pos := 0
	for i := 0; i < len(hs); {
		g0, g1 := hs[i].b0, hs[i].b1
		j := i + 1
		for j < len(hs) && joins(hs[j], g0, g1) {
			g1 = max(g1, hs[j].b1)
			j++
		}
		out = append(out, base[pos:g0]...)
		group := hs[i:j]
		out = append(out, resolve(base[g0:g1], side(base, ours, group, g0, g1, false), side(base, theirs, group, g0, g1, true))...)
		pos = g1
		i = j
	}
	return append(out, base[pos:]...)
}

// joins reports whether h overlaps the group spanning base[g0:g1]: it starts
// inside it, or both are insertions at the same place.
func joins(h hunk, g0, g1 int) bool {
	return h.b0 < g1 || g0 == g1 && h.b0 == g0 && h.b1 == h.b0
}

// side is one side's version of base[g0:g1] given its hunks in the group.
func side(base, lines []string, group []hunk, g0, g1 int, theirs bool) []string {
	var out []string
	pos := g0
	for _, h := range group {
		if h.theirs != theirs {
			continue
		}
		out = append(out, base[pos:h.b0]...)
		out = append(out, lines[h.s0:h.s1]...)
		pos = h.b1
	}
	return append(out, base[pos:g1]...)
}

func resolve(base, ours, theirs []string) []string {
	switch {
	case slices.Equal(ours, theirs), slices.Equal(theirs, base):
		return ours
	case slices.Equal(ours, base):
		return theirs
	}
	out := slices.Clone(ours)
	for _, l := range theirs {
		if !slices.Contains(base, l) && !slices.Contains(ours, l) {
			out = append(out, l)
		}
	}
	return out
}

// maxCells bounds the LCS table; a larger middle is treated as replaced whole.
const maxCells = 4_000_000

// diff lists the hunks that turn a into b, from a longest common subsequence
// of their lines.
func diff(a, b []string, theirs bool) []hunk {
	pre := 0
	for pre < len(a) && pre < len(b) && a[pre] == b[pre] {
		pre++
	}
	suf := 0
	for suf < len(a)-pre && suf < len(b)-pre && a[len(a)-1-suf] == b[len(b)-1-suf] {
		suf++
	}
	ma, mb := a[pre:len(a)-suf], b[pre:len(b)-suf]
	if len(ma) == 0 && len(mb) == 0 {
		return nil
	}
	n, m := len(ma), len(mb)
	if n == 0 || m == 0 || n*m > maxCells {
		return []hunk{{pre, pre + n, pre, pre + m, theirs}}
	}
	// lcs[i][j] is the LCS length of ma[i:] and mb[j:].
	lcs := make([]int32, (n+1)*(m+1))
	at := func(i, j int) int32 { return lcs[i*(m+1)+j] }
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if ma[i] == mb[j] {
				lcs[i*(m+1)+j] = at(i+1, j+1) + 1
			} else {
				lcs[i*(m+1)+j] = max(at(i+1, j), at(i, j+1))
			}
		}
	}
	var hs []hunk
	i, j, ci, cj := 0, 0, 0, 0
	flush := func() {
		if ci < i || cj < j {
			hs = append(hs, hunk{pre + ci, pre + i, pre + cj, pre + j, theirs})
		}
	}
	for i < n && j < m {
		switch {
		case ma[i] == mb[j]:
			flush()
			i++
			j++
			ci, cj = i, j
		case at(i+1, j) >= at(i, j+1):
			i++
		default:
			j++
		}
	}
	i, j = n, m
	flush()
	return hs
}
