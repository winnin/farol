package service

import (
	"example.com/shop/internal/model"
	"example.com/shop/internal/store"
)

// Brands reads brands from the store.
type Brands struct {
	store *store.Store
}

func NewBrands(s *store.Store) *Brands {
	return &Brands{store: s}
}

func (b *Brands) List() []model.Brand {
	return b.store.All()
}

//go:noinline
func (b *Brands) Get(id string) (model.Brand, bool) {
	return b.store.Find(id)
}
