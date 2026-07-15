"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import TopNav from "@/components/TopNav";
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  PageContainer,
  PageHeading,
  Pill,
  Spinner,
  Select,
} from "@/components/ui";
import {
  getClinicStimulusSet,
  getClinicStimulusSets,
  getImageCategories,
  getImages,
  updateClinicStimulusSet,
} from "@/utils/api";

const REQUIRED_IMAGES = 24;
const PAGE_SIZES = [10, 25, 50];
const SEARCH_DELAY_MS = 350;

function responseMessage(data, fallback) {
  if (typeof data?.error === "string") return data.error;
  return data?.message || data?.error?.message || fallback;
}

export default function StimulusSetsPage() {
  const [sets, setSets] = useState([]);
  const [library, setLibrary] = useState([]);
  const [setId, setSetId] = useState("");
  const [name, setName] = useState("");
  const [selectedImages, setSelectedImages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [libraryError, setLibraryError] = useState("");
  const [notice, setNotice] = useState("");

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [pagination, setPagination] = useState({
    total: 0,
    total_pages: 0,
    prev: null,
    next: null,
  });

  const [categories, setCategories] = useState([]);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [categoryError, setCategoryError] = useState("");

  const loadSet = useCallback(async (id) => {
    setError("");
    const res = await getClinicStimulusSet(id);
    const body = await res.json();

    if (!res.ok)
      throw new Error(responseMessage(body, "Could not load this stimulus set."));

    const item = body.data;
    setSetId(item.stimulus_set_id);
    setName(item.name || "");
    setSelectedImages(item.images || []);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadCategories = async () => {
      setCategoriesLoading(true);
      setCategoryError("");

      try {
        const res = await getImageCategories();
        const body = await res.json();
        console.log("Image categories response:", body);
        if (!res.ok)
          throw new Error(
            responseMessage(body, "Could not load image categories.")
          );

        if (cancelled) return;

        const items = Array.isArray(body.results) ? body.results : Array.isArray(body)
        const normalizedCategories = items
          .map((item) =>
            typeof item === "string" ? item : item.category
          )
          .filter(Boolean);
        setCategories(
          [...new Set(normalizedCategories)].sort((a, b) =>
            a.localeCompare(b)
          )
        );
      } catch (err) {
        if (!cancelled)
          setCategoryError(
            err.message || "Could not load image categories."
          );
      } finally {
        if (!cancelled) setCategoriesLoading(false);
      }
    };

    loadCategories();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError("");

      try {
        const res = await getClinicStimulusSets();
        const body = await res.json();

        if (!res.ok)
          throw new Error(responseMessage(body, "Could not load clinic stimulus sets."));

        const availableSets = body.data || [];
        setSets(availableSets);

        if (availableSets[0]) await loadSet(availableSets[0].stimulus_set_id);
        else
          setError(
            "No stimulus set is available for this clinic. Ask an administrator to create the initial set.",
          );
      } catch (err) {
        setError(err.message || "Unable to load the stimulus-set workspace.");
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [loadSet]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setCurrentPage(1);
      setSearch(searchInput.trim());
    }, SEARCH_DELAY_MS);

    return () => clearTimeout(timeout);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;

    const loadLibrary = async () => {
      setLibraryLoading(true);
      setLibraryError("");

      try {
        const reqQueries = {
          page: currentPage,
          limit: pageSize
        }
        if (search) reqQueries.search = search;
        if (category) reqQueries.category = category;
        const res = await getImages(reqQueries);
        const body = await res.json();

        if (!res.ok)
          throw new Error(responseMessage(body, "Could not load the image library."));
        if (cancelled) return;

        const pageData = body.pagination || {};
        const totalPages = Number(pageData.total_pages || 0);

        setLibrary(Array.isArray(body.data) ? body.data : []);
        setPagination({
          total: Number(pageData.total || 0),
          total_pages: totalPages,
          prev: pageData.prev || null,
          next: pageData.next || null,
        });

        if (totalPages > 0 && currentPage > totalPages)
          setCurrentPage(totalPages);
      } catch (err) {
        if (!cancelled) {
          setLibrary([]);
          setPagination({ total: 0, total_pages: 0, prev: null, next: null });
          setLibraryError(err.message || "Could not load the image library.");
        }
      } finally {
        if (!cancelled) setLibraryLoading(false);
      }
    };

    loadLibrary();
    return () => {
      cancelled = true;
    };
  }, [currentPage, pageSize, search, category]);

  const selectedIds = useMemo(
    () => new Set(selectedImages.map((image) => image.image_id)),
    [selectedImages],
  );

  const selectImage = (image) => {
    if (selectedIds.has(image.image_id) || selectedImages.length >= REQUIRED_IMAGES)
      return;

    setSelectedImages((current) => [
      ...current,
      { ...image, sequence_no: current.length + 1 },
    ]);
  };

  const removeImage = (imageId) => {
    setSelectedImages((current) =>
      current
        .filter((image) => image.image_id !== imageId)
        .map((image, index) => ({ ...image, sequence_no: index + 1 })),
    );
  };

  const moveImage = (index, direction) => {
    setSelectedImages((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) return current;

      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next.map((image, sequenceIndex) => ({
        ...image,
        sequence_no: sequenceIndex + 1,
      }));
    });
  };

  const chooseSet = async (id) => {
    if (id === setId || saving) return;

    try {
      setLoading(true);
      await loadSet(id);
    } catch (err) {
      setError(err.message || "Could not open this stimulus set.");
    } finally {
      setLoading(false);
    }
  };

  const save = async (status) => {
    setError("");
    setNotice("");

    if (!name.trim())
      return setError("Give this stimulus set a name before saving.");
    if (selectedImages.length !== REQUIRED_IMAGES)
      return setError(`Select exactly ${REQUIRED_IMAGES} images before saving.`);

    setSaving(true);

    try {
      const res = await updateClinicStimulusSet(setId, {
        name: name.trim(),
        status,
        images: selectedImages.map((image) => image.image_id),
      });
      const body = await res.json();

      if (!res.ok)
        throw new Error(responseMessage(body, "Could not save the stimulus set."));

      const updated = body.data;
      setSetId(updated.stimulus_set_id);
      setName(updated.name || "");
      setSelectedImages(updated.images || []);
      setNotice(
        body.meta?.created_new_version
          ? `Version ${updated.version} was created and ${status === "active" ? "activated" : "saved as a draft"
          }.`
          : `Stimulus set ${status === "active"
            ? "activated for future sessions"
            : "saved as a draft"
          }.`,
      );

      const setsRes = await getClinicStimulusSets();
      if (setsRes.ok) setSets((await setsRes.json()).data || []);
    } catch (err) {
      setError(err.message || "Could not save the stimulus set.");
    } finally {
      setSaving(false);
    }
  };

  const changePageSize = (event) => {
    const nextSize = Number(event.target.value);
    if (!PAGE_SIZES.includes(nextSize)) return;
    setPageSize(nextSize);
    setCurrentPage(1);
  };

  const changeCategory = (event) => {
    setCategory(event.target.value);
    setCurrentPage(1);
  };

  return (
    <main className="min-h-screen bg-ground">
      <TopNav />
      <PageContainer width="full" className="py-8 space-y-6">
        <PageHeading
          title="Clinic stimulus set"
          subtitle="Choose the ordered 24-image sequence used by future sessions at your clinic. Activating changes the clinic default without altering past sessions."
          actions={
            <Pill tone="accent">
              {selectedImages.length} / {REQUIRED_IMAGES} selected
            </Pill>
          }
        />

        {error && <Alert tone="crit">{error}</Alert>}
        {notice && <Alert tone="good">{notice}</Alert>}

        {loading ? (
          <Card className="p-12 text-center text-muted">
            <Spinner className="mr-2" /> Loading stimulus sets…
          </Card>
        ) : (
          <div className="grid gap-6 xl:grid-cols-[280px_minmax(0,1fr)]">
            <Card className="h-fit overflow-hidden">
              <CardHeader
                title="Available versions"
                subtitle="Active sets are used by new sessions."
              />
              <div className="p-3 space-y-2">
                {sets.map((item) => (
                  <button
                    key={item.stimulus_set_id}
                    onClick={() => chooseSet(item.stimulus_set_id)}
                    className={`w-full rounded-xl border p-3 text-left transition-colors ${item.stimulus_set_id === setId
                      ? "border-accent bg-accent-soft"
                      : "border-transparent hover:bg-inset"
                      }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-sm text-ink truncate">
                        {item.name}
                      </span>
                      <Pill tone={item.status === "active" ? "good" : "neutral"}>
                        {item.status}
                      </Pill>
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      Version {item.version} · {item.image_count} images
                    </p>
                  </button>
                ))}
              </div>
            </Card>

            <div className="space-y-6 min-w-0">
              <Card>
                <CardHeader
                  title="Configure selected version"
                  subtitle="The image order is the presentation order during a session."
                />
                <div className="p-5 space-y-4">
                  <Field label="Stimulus set name" htmlFor="set-name">
                    <Input
                      id="set-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      disabled={!setId || saving}
                    />
                  </Field>
                  <div className="flex flex-wrap justify-between gap-3 border-t border-border pt-4">
                    <p className="text-sm text-muted">
                      Save a draft to review it later, or activate it as the clinic default.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={saving}
                        onClick={() => save("draft")}
                        disabled={!setId}
                      >
                        Save draft
                      </Button>
                      <Button
                        size="sm"
                        loading={saving}
                        onClick={() => save("active")}
                        disabled={!setId}
                      >
                        Activate for sessions
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>

              <Card className="overflow-hidden">
                <CardHeader
                  title={`Session sequence (${selectedImages.length}/${REQUIRED_IMAGES})`}
                  subtitle="Use the arrows to set the display order. Each image can be used once."
                />
                {selectedImages.length === 0 ? (
                  <div className="p-8 text-center text-sm text-muted">
                    Select images from the library to build this sequence.
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 p-4">
                    {selectedImages.map((image, index) => (
                      <SelectedImage
                        key={image.image_id}
                        image={image}
                        index={index}
                        onMove={moveImage}
                        onRemove={removeImage}
                      />
                    ))}
                  </div>
                )}
              </Card>

              <Card className="overflow-hidden">
                <CardHeader
                  title="Image library"
                  subtitle={`${pagination.total} matching image${pagination.total === 1 ? "" : "s"
                    }. Search and category filters are applied by the API.`}
                />

                <div className="grid gap-3 border-b border-border p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,220px)_160px]">
                  <Input
                    aria-label="Search image filenames"
                    placeholder="Search filename"
                    value={searchInput}
                    onChange={(event) => setSearchInput(event.target.value)}
                  />
                  {categoryError && (
                    <div className="px-4 pt-4">
                      <Alert tone="crit">{categoryError}</Alert>
                    </div>
                  )}
                  <Select
                    value={category}
                    onChange={changeCategory}
                    disabled={categoriesLoading}
                    aria-label="Filter image category"
                    className="w-full py-2.5 text-sm"
                  >
                    <option value="">
                      {categoriesLoading ? "Loading categories…" : "All categories"}
                    </option>

                    {categories.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </Select>
                  <Select
                    value={pageSize}
                    onChange={changePageSize}
                    className="w-full py-2.5 text-sm"
                    aria-label="Images per page"
                  >
                    <option value="10">10 per page</option>
                    <option value="25">25 per page</option>
                    <option value="50">50 per page</option>
                  </Select>
                </div>

                {libraryError && (
                  <div className="p-4">
                    <Alert tone="crit">{libraryError}</Alert>
                  </div>
                )}

                {libraryLoading ? (
                  <div className="p-12 text-center text-sm text-muted">
                    <Spinner className="mr-2" /> Loading image library…
                  </div>
                ) : library.length === 0 ? (
                  <div className="p-12 text-center text-sm text-muted">
                    No images matched the current search and category filters.
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 p-4">
                    {library.map((image) => (
                      <LibraryImage
                        key={image.image_id}
                        image={image}
                        selected={selectedIds.has(image.image_id)}
                        disabled={selectedImages.length >= REQUIRED_IMAGES}
                        onSelect={selectImage}
                      />
                    ))}
                  </div>
                )}

                <Pagination
                  current={currentPage}
                  total={pagination.total_pages}
                  hasPrev={Boolean(pagination.prev)}
                  hasNext={Boolean(pagination.next)}
                  loading={libraryLoading}
                  onPageChange={setCurrentPage}
                />
              </Card>
            </div>
          </div>
        )}
      </PageContainer>
    </main>
  );
}

function ImagePreview({ image }) {
  // eslint-disable-next-line @next/next/no-img-element
  return image.url ? (
    <img
      src={image.url}
      alt=""
      className="h-24 w-full rounded-lg object-cover bg-inset"
    />
  ) : (
    <div className="h-24 rounded-lg bg-inset" />
  );
}

function SelectedImage({ image, index, onMove, onRemove }) {
  return (
    <div className="rounded-xl border border-border p-2 bg-surface">
      <ImagePreview image={image} />
      <div className="flex items-center justify-between gap-1 mt-2">
        <span className="font-mono text-[11px] text-muted">
          {index + 1}. {image.filename || "Image"}
        </span>
        <button
          onClick={() => onRemove(image.image_id)}
          className="text-xs font-semibold text-crit hover:underline"
        >
          Remove
        </button>
      </div>
      <div className="mt-2 flex gap-1">
        <Button
          variant="subtle"
          size="sm"
          className="flex-1 px-2"
          onClick={() => onMove(index, -1)}
          disabled={index === 0}
          aria-label={`Move image ${index + 1} earlier`}
        >
          ↑
        </Button>
        <Button
          variant="subtle"
          size="sm"
          className="flex-1 px-2"
          onClick={() => onMove(index, 1)}
          disabled={index === 23}
          aria-label={`Move image ${index + 1} later`}
        >
          ↓
        </Button>
      </div>
    </div>
  );
}

function LibraryImage({ image, selected, disabled, onSelect }) {
  return (
    <button
      onClick={() => onSelect(image)}
      disabled={selected || disabled}
      className={`rounded-xl border p-2 text-left transition-colors disabled:cursor-default ${selected
        ? "border-good bg-good-soft"
        : "border-border hover:border-accent"
        }`}
    >
      <ImagePreview image={image} />
      <div className="mt-2 flex justify-between gap-2">
        <span className="truncate text-xs font-semibold text-ink">
          {image.filename || "Unnamed image"}
        </span>
        {selected && (
          <span className="text-[11px] font-semibold text-good">Added</span>
        )}
      </div>
      {image.category && (
        <p className="mt-0.5 text-[11px] text-muted truncate">
          {image.category}
        </p>
      )}
    </button>
  );
}

function Pagination({
  current,
  total,
  hasPrev,
  hasNext,
  loading,
  onPageChange,
}) {
  if (total <= 1) return null;

  const pages = getVisiblePages(current, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4">
      <p className="text-sm text-muted">
        Page {current} of {total}
      </p>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="subtle"
          size="sm"
          onClick={() => onPageChange(current - 1)}
          disabled={!hasPrev || loading}
        >
          Previous
        </Button>

        {pages.map((page, index) =>
          page === "ellipsis" ? (
            <span key={`ellipsis-${index}`} className="px-1 text-muted">
              …
            </span>
          ) : (
            <button
              key={page}
              onClick={() => onPageChange(page)}
              disabled={loading}
              aria-current={page === current ? "page" : undefined}
              className={`min-w-9 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${page === current
                ? "bg-accent text-white"
                : "bg-surface hover:bg-accent-soft"
                }`}
            >
              {page}
            </button>
          ),
        )}

        <Button
          variant="subtle"
          size="sm"
          onClick={() => onPageChange(current + 1)}
          disabled={!hasNext || loading}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function getVisiblePages(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);

  const pages = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);

  if (start > 2) pages.push("ellipsis");
  for (let page = start; page <= end; page += 1) pages.push(page);
  if (end < total - 1) pages.push("ellipsis");

  pages.push(total);
  return pages;
}
