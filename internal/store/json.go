package store

import (
	"encoding/json"
	"reflect"
	"strings"
)

// Preserve fields not understood by this binary, including nested legacy config.
func preserveFields(old, current []byte, typ reflect.Type) ([]byte, error) {
	var prior, next map[string]json.RawMessage
	if len(old) > 0 {
		if err := json.Unmarshal(old, &prior); err != nil {
			return nil, err
		}
	}
	if err := json.Unmarshal(current, &next); err != nil {
		return nil, err
	}
	if prior == nil {
		prior = make(map[string]json.RawMessage)
	}
	for typ.Kind() == reflect.Pointer {
		typ = typ.Elem()
	}
	for i := 0; i < typ.NumField(); i++ {
		f := typ.Field(i)
		if f.PkgPath != "" {
			continue
		}
		key := strings.Split(f.Tag.Get("json"), ",")[0]
		if key == "-" {
			continue
		}
		if key == "" {
			key = f.Name
		}
		value, ok := next[key]
		if !ok {
			delete(prior, key)
			continue
		}
		nested := f.Type
		for nested.Kind() == reflect.Pointer {
			nested = nested.Elem()
		}
		if nested.Kind() == reflect.Struct && len(prior[key]) > 0 && string(prior[key]) != "null" && string(value) != "null" {
			merged, err := preserveFields(prior[key], value, nested)
			if err != nil {
				return nil, err
			}
			value = merged
		}
		prior[key] = value
	}
	return json.Marshal(prior)
}
func (t *Task) UnmarshalJSON(data []byte) error {
	type plain Task
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	_, current := fields["runtimeVersion"]
	if len(fields["version"]) == 0 {
		current = true
	}
	if !current {
		normalized, err := migrateDocument(data)
		if err != nil {
			return err
		}
		data = normalized
	}
	var p plain
	if err := json.Unmarshal(data, &p); err != nil {
		return err
	}
	*t = Task(p)
	t.Legacy = !current
	t.original = append(json.RawMessage(nil), data...)
	return nil
}
func (t Task) MarshalJSON() ([]byte, error) {
	type plain Task
	b, err := json.Marshal(plain(t))
	if err != nil {
		return nil, err
	}
	return preserveFields(t.original, b, reflect.TypeOf(t))
}
func (r *Run) UnmarshalJSON(data []byte) error {
	type plain Run
	var p plain
	if err := json.Unmarshal(data, &p); err != nil {
		return err
	}
	*r = Run(p)
	r.original = append(json.RawMessage(nil), data...)
	return nil
}
func (r Run) MarshalJSON() ([]byte, error) {
	type plain Run
	b, err := json.Marshal(plain(r))
	if err != nil {
		return nil, err
	}
	return preserveFields(r.original, b, reflect.TypeOf(r))
}
