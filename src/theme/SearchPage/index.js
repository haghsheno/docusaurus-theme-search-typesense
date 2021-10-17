/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import React, {useEffect, useState, useReducer, useRef} from 'react';

import algoliaSearchHelper from 'algoliasearch-helper';
import clsx from 'clsx';

import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import ExecutionEnvironment from '@docusaurus/ExecutionEnvironment';
import {useTitleFormatter, usePluralForm} from '@docusaurus/theme-common';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import {useAllDocsData} from '@theme/hooks/useDocs';
import useSearchQuery from '@theme/hooks/useSearchQuery';
import Layout from '@theme/Layout';
import Translate, {translate} from '@docusaurus/Translate';
import styles from './styles.module.css';
import TypesenseInstantSearchAdapter from "typesense-instantsearch-adapter";

// Very simple pluralization: probably good enough for now
function useDocumentsFoundPlural() {
  const {selectMessage} = usePluralForm();
  return (count) =>
    selectMessage(
      count,
      translate(
        {
          id: 'theme.SearchPage.documentsFound.plurals',
          description:
            'Pluralized label for "{count} documents found". Use as much plural forms (separated by "|") as your language support (see https://www.unicode.org/cldr/cldr-aux/charts/34/supplemental/language_plural_rules.html)',
          message: 'One document found|{count} documents found',
        },
        {count},
      ),
    );
}

function useDocsSearchVersionsHelpers() {
  const allDocsData = useAllDocsData();

  // State of the version select menus / facet filters
  // docsPluginId -> versionName map
  const [searchVersions, setSearchVersions] = useState(() => {
    return Object.entries(allDocsData).reduce((acc, [pluginId, pluginData]) => {
      return {...acc, [pluginId]: pluginData.versions[0].name};
    }, {});
  });

  // Set the value of a single select menu
  const setSearchVersion = (pluginId, searchVersion) =>
    setSearchVersions((s) => ({...s, [pluginId]: searchVersion}));

  const versioningEnabled = Object.values(allDocsData).some(
    (docsData) => docsData.versions.length > 1,
  );

  return {
    allDocsData,
    versioningEnabled,
    searchVersions,
    setSearchVersion,
  };
}

// We want to display one select per versioned docs plugin instance
const SearchVersionSelectList = ({docsSearchVersionsHelpers}) => {
  const versionedPluginEntries = Object.entries(
    docsSearchVersionsHelpers.allDocsData,
  )
    // Do not show a version select for unversioned docs plugin instances
    .filter(([, docsData]) => docsData.versions.length > 1);

  return (
    <div
      className={clsx(
        'col',
        'col--3',
        'padding-left--none',
        styles.searchVersionColumn,
      )}>
      {versionedPluginEntries.map(([pluginId, docsData]) => {
        const labelPrefix =
          versionedPluginEntries.length > 1 ? `${pluginId}: ` : '';
        return (
          <select
            key={pluginId}
            onChange={(e) =>
              docsSearchVersionsHelpers.setSearchVersion(
                pluginId,
                e.target.value,
              )
            }
            defaultValue={docsSearchVersionsHelpers.searchVersions[pluginId]}
            className={styles.searchVersionInput}>
            {docsData.versions.map((version, i) => (
              <option
                key={i}
                label={`${labelPrefix}${version.label}`}
                value={version.name}
              />
            ))}
          </select>
        );
      })}
    </div>
  );
};

function SearchPage() {
  const {
    siteConfig: {
      themeConfig: {
        typesense: {typesenseCollectionName, typesenseServerConfig, typesenseSearchParameters},
      },
    },
    i18n: {currentLocale},
  } = useDocusaurusContext();
  const documentsFoundPlural = useDocumentsFoundPlural();

  const docsSearchVersionsHelpers = useDocsSearchVersionsHelpers();
  const {searchValue, updateSearchPath} = useSearchQuery();
  const [searchQuery, setSearchQuery] = useState(searchValue);
  const initialSearchResultState = {
    items: [],
    query: null,
    totalResults: null,
    totalPages: null,
    lastPage: null,
    hasMore: null,
    loading: null,
  };
  const [searchResultState, searchResultStateDispatcher] = useReducer(
    (prevState, {type, value: state}) => {
      switch (type) {
        case 'reset': {
          return initialSearchResultState;
        }
        case 'loading': {
          return {...prevState, loading: true};
        }
        case 'update': {
          if (searchQuery !== state.query) {
            return prevState;
          }

          return {
            ...state,
            items:
              state.lastPage === 0
                ? state.items
                : prevState.items.concat(state.items),
          };
        }
        case 'advance': {
          const hasMore = prevState.totalPages > prevState.lastPage + 1;

          return {
            ...prevState,
            lastPage: hasMore ? prevState.lastPage + 1 : prevState.lastPage,
            hasMore,
          };
        }
        default:
          return prevState;
      }
    },
    initialSearchResultState,
  );
  const typesenseInstantSearchAdapter = new TypesenseInstantSearchAdapter({
    server: typesenseServerConfig,
    additionalSearchParameters: {
      queryBy:
        'hierarchy.lvl0,hierarchy.lvl1,hierarchy.lvl2,hierarchy.lvl3,hierarchy.lvl4,hierarchy.lvl5,hierarchy.lvl6,content',
      includeFields:
        'hierarchy.lvl0,hierarchy.lvl1,hierarchy.lvl2,hierarchy.lvl3,hierarchy.lvl4,hierarchy.lvl5,hierarchy.lvl6,content,anchor,url,type,id',
      highlightFullFields:
        'hierarchy.lvl0,hierarchy.lvl1,hierarchy.lvl2,hierarchy.lvl3,hierarchy.lvl4,hierarchy.lvl5,hierarchy.lvl6,content',
      groupBy: 'url',
      groupLimit: 3,
      ...typesenseSearchParameters
    },
  });
  const algoliaHelper = algoliaSearchHelper(typesenseInstantSearchAdapter.searchClient, typesenseCollectionName, {
    hitsPerPage: 15,
    advancedSyntax: true,
    disjunctiveFacets: ['language'],
    highlightPreTag: '<algolia-docsearch-suggestion--highlight>',
    highlightPostTag: '</algolia-docsearch-suggestion--highlight>',
  });

  algoliaHelper.on(
    'result',
    ({results: {query, hits, page, nbHits, nbPages}}) => {
      if (query === '' || !(hits instanceof Array)) {
        searchResultStateDispatcher({type: 'reset'});
        return;
      }

      const sanitizeValue = (value) => {
        return value.replace(
          /<algolia-docsearch-suggestion--highlight>/g,
          '<span class="search-result-match">',
        ).replace(/<\/algolia-docsearch-suggestion--highlight>/g, '</span>');
      };

      const items = hits.map(
        ({
          url,
          _highlightResult,
          _snippetResult: snippet = {},
        }) => {
          const {pathname, hash} = new URL(url);
          const titles = [0, 1, 2, 3, 4, 5, 6].map(lvl => {
            const highlightResult = _highlightResult[`hierarchy.lvl${lvl}`]
            return highlightResult ? sanitizeValue(highlightResult.value) : null;
          }).filter(v => v);

          return {
            title: titles.pop(),
            url: pathname + hash,
            summary: snippet.content
              ? `${sanitizeValue(snippet.content.value)}...`
              : '',
            breadcrumbs: titles,
          };
        },
      );

      searchResultStateDispatcher({
        type: 'update',
        value: {
          items,
          query,
          totalResults: nbHits,
          totalPages: nbPages,
          lastPage: page,
          hasMore: nbPages > page + 1,
          loading: false,
        },
      });
    },
  );

  const [loaderRef, setLoaderRef] = useState(null);
  const prevY = useRef(0);
  const observer = useRef(
    ExecutionEnvironment.canUseDOM &&
      new IntersectionObserver(
        (entries) => {
          const {
            isIntersecting,
            boundingClientRect: {y: currentY},
          } = entries[0];

          if (isIntersecting && prevY.current > currentY) {
            searchResultStateDispatcher({type: 'advance'});
          }

          prevY.current = currentY;
        },
        {threshold: 1},
      ),
  );

  const getTitle = () =>
    searchQuery
      ? translate(
          {
            id: 'theme.SearchPage.existingResultsTitle',
            message: 'Search results for "{query}"',
            description: 'The search page title for non-empty query',
          },
          {
            query: searchQuery,
          },
        )
      : translate({
          id: 'theme.SearchPage.emptyResultsTitle',
          message: 'Search the documentation',
          description: 'The search page title for empty query',
        });

  const makeSearch = (page = 0) => {
    if (!typesenseSearchParameters.filter_by && typesenseSearchParameters.filter_by !== '') {
      algoliaHelper.addDisjunctiveFacetRefinement('docusaurus_tag', 'default');
      algoliaHelper.addDisjunctiveFacetRefinement('language', currentLocale);

      Object.entries(docsSearchVersionsHelpers.searchVersions).forEach(
        ([pluginId, searchVersion]) => {
          algoliaHelper.addDisjunctiveFacetRefinement(
            'docusaurus_tag',
            `docs-${pluginId}-${searchVersion}`,
          );
        },
      );
    }
    algoliaHelper.setQuery(searchQuery).setPage(page).search();
  };

  useEffect(() => {
    if (!loaderRef) {
      return undefined;
    }

    observer.current.observe(loaderRef);

    return () => {
      observer.current.unobserve(loaderRef);
    };
  }, [loaderRef]);

  useEffect(() => {
    updateSearchPath(searchQuery);

    searchResultStateDispatcher({type: 'reset'});

    if (searchQuery) {
      searchResultStateDispatcher({type: 'loading'});

      setTimeout(() => {
        makeSearch();
      }, 300);
    }
  }, [searchQuery, docsSearchVersionsHelpers.searchVersions]);

  useEffect(() => {
    if (!searchResultState.lastPage || searchResultState.lastPage === 0) {
      return;
    }

    makeSearch(searchResultState.lastPage);
  }, [searchResultState.lastPage]);

  useEffect(() => {
    if (searchValue && searchValue !== searchQuery) {
      setSearchQuery(searchValue);
    }
  }, [searchValue]);

  return (
    <Layout wrapperClassName="search-page-wrapper">
      <Head>
        <title>{useTitleFormatter(getTitle())}</title>
        {/*
         We should not index search pages
          See https://github.com/facebook/docusaurus/pull/3233
        */}
        <meta property="robots" content="noindex, follow" />
      </Head>

      <div className="container margin-vert--lg">
        <h1>{getTitle()}</h1>

        <form className="row" onSubmit={(e) => e.preventDefault()}>
          <div
            className={clsx('col', styles.searchQueryColumn, {
              'col--9': docsSearchVersionsHelpers.versioningEnabled,
              'col--12': !docsSearchVersionsHelpers.versioningEnabled,
            })}>
            <input
              type="search"
              name="q"
              className={styles.searchQueryInput}
              placeholder={translate({
                id: 'theme.SearchPage.inputPlaceholder',
                message: 'Type your search here',
                description: 'The placeholder for search page input',
              })}
              aria-label={translate({
                id: 'theme.SearchPage.inputLabel',
                message: 'Search',
                description: 'The ARIA label for search page input',
              })}
              onChange={(e) => setSearchQuery(e.target.value)}
              value={searchQuery}
              autoComplete="off"
              autoFocus
            />
          </div>

          {docsSearchVersionsHelpers.versioningEnabled && (
            <SearchVersionSelectList
              docsSearchVersionsHelpers={docsSearchVersionsHelpers}
            />
          )}
        </form>

        <div className="row">
          <div className={clsx('col', 'col--8', styles.searchResultsColumn)}>
            {!!searchResultState.totalResults &&
              documentsFoundPlural(searchResultState.totalResults)}
          </div>

          <div
            className={clsx(
              'col',
              'col--4',
              'text--right',
              styles.searchLogoColumn,
            )}>
            <a
              target="_blank"
              rel="noopener noreferrer"
              href="https://typesense.org/"
              aria-label={translate({
                id: 'theme.SearchPage.algoliaLabel',
                message: 'Search by Typesense',
                description: 'The ARIA label for Typesense mention',
              })}>
              <svg width="141" height="21" viewBox="0 0 141 21" fill="none" xmlns="http://www.w3.org/2000/svg" className={styles.algoliaLogo}>
                <g clipPath="url(#clip0)">
                  <rect width="141" height="21" fill="white"/>
                  <path d="M62.0647 6.453C62.1018 6.643 62.1204 6.82667 62.1204 7.004C62.1204 7.16867 62.1018 7.346 62.0647 7.536L59.7086 7.517V13.901C59.7086 14.433 59.9498 14.699 60.4321 14.699H61.8421C61.9287 14.9143 61.972 15.1297 61.972 15.345C61.972 15.5603 61.9596 15.6933 61.9349 15.744C61.3659 15.82 60.7785 15.858 60.1724 15.858C58.9727 15.858 58.3729 15.3323 58.3729 14.281V7.517L57.0557 7.536C57.0186 7.346 57 7.16867 57 7.004C57 6.82667 57.0186 6.643 57.0557 6.453L58.3729 6.472V4.477C58.3729 4.135 58.4223 3.89433 58.5213 3.755C58.6202 3.603 58.8119 3.527 59.0964 3.527H59.5973L59.7086 3.641V6.491L62.0647 6.453Z" fill="#1035BC"/>
                  <path d="M71.0419 6.548L68.5003 15.459C68.0303 17.093 67.5294 18.2457 66.9976 18.917C66.4658 19.5883 65.668 19.924 64.6044 19.924C64.0602 19.924 63.5592 19.8417 63.1016 19.677C63.0645 19.3223 63.1635 18.9803 63.3985 18.651C63.7819 18.7903 64.19 18.86 64.6229 18.86C65.2784 18.86 65.7793 18.632 66.1256 18.176C66.4719 17.72 66.7873 17.0107 67.0718 16.048L67.1274 15.858C66.8059 15.8327 66.5585 15.7567 66.3854 15.63C66.2246 15.5033 66.0885 15.269 65.9772 14.927L63.3799 6.567C63.7633 6.40233 64.0354 6.32 64.1962 6.32C64.5549 6.32 64.7961 6.54167 64.9197 6.985L66.3854 11.754C66.4348 11.906 66.7193 12.894 67.2388 14.718C67.2635 14.8067 67.3253 14.851 67.4243 14.851L69.6876 6.453C69.8484 6.40233 70.0587 6.377 70.3184 6.377C70.5905 6.377 70.8193 6.415 71.0048 6.491L71.0419 6.548Z" fill="#1035BC"/>
                  <path d="M74.6067 15.155V18.917C74.6067 19.259 74.5572 19.4997 74.4583 19.639C74.3594 19.791 74.1615 19.867 73.8646 19.867H73.3637L73.2524 19.753V6.51L73.3637 6.396H73.8461C74.1429 6.396 74.3408 6.47833 74.4397 6.643C74.5511 6.795 74.6067 7.04833 74.6067 7.403V7.498C75.3488 6.64933 76.2331 6.225 77.2597 6.225C78.311 6.225 79.1025 6.662 79.6343 7.536C80.1662 8.39733 80.4321 9.59434 80.4321 11.127C80.4321 11.8743 80.3331 12.5457 80.1353 13.141C79.9497 13.7363 79.6962 14.243 79.3746 14.661C79.0654 15.0663 78.7067 15.383 78.2986 15.611C77.8904 15.8263 77.4699 15.934 77.037 15.934C76.1836 15.934 75.3735 15.6743 74.6067 15.155ZM74.6067 8.98V13.863C75.3612 14.433 76.0723 14.718 76.7402 14.718C77.4081 14.718 77.9585 14.414 78.3914 13.806C78.8242 13.198 79.0407 12.2797 79.0407 11.051C79.0407 10.443 78.985 9.91734 78.8737 9.474C78.7748 9.018 78.6387 8.64433 78.4656 8.353C78.2924 8.049 78.0883 7.82733 77.8533 7.688C77.6307 7.536 77.3895 7.46 77.1298 7.46C76.6351 7.46 76.1651 7.593 75.7198 7.859C75.2746 8.125 74.9035 8.49867 74.6067 8.98Z" fill="#1035BC"/>
                  <path d="M89.8263 11.545H84.0751C84.137 13.6983 84.9347 14.775 86.4683 14.775C87.3094 14.775 88.2061 14.509 89.1584 13.977C89.4305 14.2303 89.5975 14.5533 89.6593 14.946C88.6451 15.6553 87.5073 16.01 86.2457 16.01C85.6026 16.01 85.0522 15.8897 84.5946 15.649C84.137 15.3957 83.7597 15.0537 83.4629 14.623C83.1784 14.1797 82.9682 13.6603 82.8321 13.065C82.6961 12.4697 82.6281 11.8173 82.6281 11.108C82.6281 10.386 82.7084 9.72733 82.8692 9.132C83.0424 8.53667 83.2897 8.02367 83.6113 7.593C83.9329 7.16233 84.3163 6.82667 84.7616 6.586C85.2192 6.34533 85.7386 6.225 86.3199 6.225C86.8889 6.225 87.396 6.33267 87.8412 6.548C88.2988 6.75067 88.6761 7.03567 88.9729 7.403C89.2821 7.75767 89.5171 8.18833 89.6779 8.695C89.8387 9.189 89.919 9.721 89.919 10.291C89.919 10.519 89.9067 10.7407 89.8819 10.956C89.8696 11.1587 89.851 11.355 89.8263 11.545ZM84.0751 10.462H88.5276V10.215C88.5276 9.341 88.3483 8.638 87.9896 8.106C87.6309 7.574 87.0929 7.308 86.3756 7.308C85.6706 7.308 85.1202 7.593 84.7244 8.163C84.341 8.733 84.1246 9.49933 84.0751 10.462Z" fill="#1035BC"/>
                  <path d="M91.7359 15.117C91.7482 14.8383 91.8224 14.5343 91.9585 14.205C92.1069 13.863 92.2739 13.597 92.4594 13.407C93.4365 13.9517 94.2961 14.224 95.0381 14.224C95.4463 14.224 95.774 14.1417 96.0214 13.977C96.2811 13.8123 96.411 13.5907 96.411 13.312C96.411 12.8687 96.0771 12.514 95.4092 12.248L94.3703 11.849C92.8119 11.2663 92.0327 10.3353 92.0327 9.056C92.0327 8.6 92.1131 8.19467 92.2739 7.84C92.447 7.47267 92.682 7.16233 92.9789 6.909C93.2881 6.643 93.6529 6.44033 94.0734 6.301C94.4939 6.16167 94.9639 6.092 95.4834 6.092C95.7184 6.092 95.9781 6.111 96.2626 6.149C96.5594 6.187 96.8562 6.244 97.1531 6.32C97.4499 6.38333 97.7344 6.45933 98.0065 6.548C98.2786 6.63667 98.5136 6.73167 98.7115 6.833C98.7115 7.14967 98.6496 7.479 98.5259 7.821C98.4023 8.163 98.2353 8.41633 98.025 8.581C97.048 8.13767 96.2007 7.916 95.4834 7.916C95.1618 7.916 94.9083 7.99833 94.7228 8.163C94.5372 8.315 94.4445 8.51767 94.4445 8.771C94.4445 9.16367 94.7537 9.474 95.3721 9.702L96.5038 10.12C97.3201 10.4113 97.9261 10.8103 98.3219 11.317C98.7176 11.8237 98.9155 12.4127 98.9155 13.084C98.9155 13.9833 98.5878 14.7053 97.9323 15.25C97.2768 15.782 96.3368 16.048 95.1123 16.048C93.9126 16.048 92.7871 15.7377 91.7359 15.117Z" fill="#1035BC"/>
                  <path d="M107.996 11.868H102.875C102.912 12.5647 103.067 13.1157 103.339 13.521C103.623 13.9137 104.112 14.11 104.805 14.11C105.522 14.11 106.344 13.8947 107.272 13.464C107.631 13.844 107.859 14.3443 107.958 14.965C106.969 15.687 105.782 16.048 104.396 16.048C103.085 16.048 102.09 15.6363 101.409 14.813C100.742 13.977 100.408 12.742 100.408 11.108C100.408 10.348 100.494 9.664 100.667 9.056C100.841 8.43533 101.094 7.90967 101.428 7.479C101.762 7.03567 102.17 6.69367 102.652 6.453C103.135 6.21233 103.685 6.092 104.304 6.092C104.934 6.092 105.491 6.19333 105.973 6.396C106.456 6.586 106.864 6.86467 107.198 7.232C107.532 7.58667 107.779 8.011 107.94 8.505C108.113 8.999 108.2 9.53733 108.2 10.12C108.2 10.4367 108.181 10.7407 108.144 11.032C108.107 11.3107 108.057 11.5893 107.996 11.868ZM104.415 7.878C103.45 7.878 102.931 8.62533 102.857 10.12H105.936V9.892C105.936 9.284 105.813 8.79633 105.565 8.429C105.318 8.06167 104.934 7.878 104.415 7.878Z" fill="#1035BC"/>
                  <path d="M118.163 9.436V13.578C118.163 14.3887 118.293 14.9903 118.553 15.383C118.157 15.7377 117.681 15.915 117.124 15.915C116.592 15.915 116.227 15.7947 116.029 15.554C115.832 15.3007 115.733 14.908 115.733 14.376V9.949C115.733 9.379 115.665 8.98 115.529 8.752C115.392 8.524 115.139 8.41 114.768 8.41C114.112 8.41 113.5 8.714 112.931 9.322V15.782C112.746 15.82 112.548 15.8453 112.338 15.858C112.14 15.8707 111.936 15.877 111.725 15.877C111.515 15.877 111.305 15.8707 111.095 15.858C110.897 15.8453 110.705 15.82 110.519 15.782V6.377L110.631 6.244H111.558C112.251 6.244 112.684 6.624 112.857 7.384C113.76 6.586 114.657 6.187 115.547 6.187C116.438 6.187 117.093 6.48467 117.514 7.08C117.947 7.66267 118.163 8.448 118.163 9.436Z" fill="#1035BC"/>
                  <path d="M120.109 15.117C120.121 14.8383 120.196 14.5343 120.332 14.205C120.48 13.863 120.647 13.597 120.833 13.407C121.81 13.9517 122.669 14.224 123.411 14.224C123.819 14.224 124.147 14.1417 124.395 13.977C124.654 13.8123 124.784 13.5907 124.784 13.312C124.784 12.8687 124.45 12.514 123.782 12.248L122.743 11.849C121.185 11.2663 120.406 10.3353 120.406 9.056C120.406 8.6 120.486 8.19467 120.647 7.84C120.82 7.47267 121.055 7.16233 121.352 6.909C121.661 6.643 122.026 6.44033 122.447 6.301C122.867 6.16167 123.337 6.092 123.857 6.092C124.092 6.092 124.351 6.111 124.636 6.149C124.933 6.187 125.229 6.244 125.526 6.32C125.823 6.38333 126.108 6.45933 126.38 6.548C126.652 6.63667 126.887 6.73167 127.085 6.833C127.085 7.14967 127.023 7.479 126.899 7.821C126.775 8.163 126.608 8.41633 126.398 8.581C125.421 8.13767 124.574 7.916 123.857 7.916C123.535 7.916 123.281 7.99833 123.096 8.163C122.91 8.315 122.818 8.51767 122.818 8.771C122.818 9.16367 123.127 9.474 123.745 9.702L124.877 10.12C125.693 10.4113 126.299 10.8103 126.695 11.317C127.091 11.8237 127.289 12.4127 127.289 13.084C127.289 13.9833 126.961 14.7053 126.305 15.25C125.65 15.782 124.71 16.048 123.486 16.048C122.286 16.048 121.16 15.7377 120.109 15.117Z" fill="#1035BC"/>
                  <path d="M136.369 11.868H131.248C131.285 12.5647 131.44 13.1157 131.712 13.521C131.997 13.9137 132.485 14.11 133.178 14.11C133.895 14.11 134.718 13.8947 135.645 13.464C136.004 13.844 136.233 14.3443 136.332 14.965C135.342 15.687 134.155 16.048 132.77 16.048C131.459 16.048 130.463 15.6363 129.783 14.813C129.115 13.977 128.781 12.742 128.781 11.108C128.781 10.348 128.867 9.664 129.041 9.056C129.214 8.43533 129.467 7.90967 129.801 7.479C130.135 7.03567 130.543 6.69367 131.026 6.453C131.508 6.21233 132.058 6.092 132.677 6.092C133.308 6.092 133.864 6.19333 134.347 6.396C134.829 6.586 135.237 6.86467 135.571 7.232C135.905 7.58667 136.152 8.011 136.313 8.505C136.486 8.999 136.573 9.53733 136.573 10.12C136.573 10.4367 136.554 10.7407 136.517 11.032C136.48 11.3107 136.431 11.5893 136.369 11.868ZM132.788 7.878C131.823 7.878 131.304 8.62533 131.23 10.12H134.309V9.892C134.309 9.284 134.186 8.79633 133.938 8.429C133.691 8.06167 133.308 7.878 132.788 7.878Z" fill="#1035BC"/>
                  <path d="M139.245 18.442V1.057C139.431 1.019 139.641 1 139.876 1C140.123 1 140.352 1.019 140.562 1.057V18.442C140.352 18.48 140.123 18.499 139.876 18.499C139.641 18.499 139.431 18.48 139.245 18.442Z" fill="#1035BC"/>
                  <path d="M2.648 14.604C2.864 14.748 3.204 14.876 3.668 14.988C4.132 15.1 4.54 15.156 4.892 15.156C5.484 15.156 5.996 15.064 6.428 14.88C6.868 14.696 7.2 14.444 7.424 14.124C7.656 13.804 7.772 13.436 7.772 13.02C7.772 12.636 7.692 12.308 7.532 12.036C7.372 11.756 7.136 11.508 6.824 11.292C6.52 11.076 6.116 10.852 5.612 10.62C5.052 10.364 4.628 10.152 4.34 9.984C4.052 9.816 3.828 9.632 3.668 9.432C3.516 9.224 3.44 8.976 3.44 8.688C3.44 8.304 3.596 8.004 3.908 7.788C4.228 7.572 4.652 7.464 5.18 7.464C5.532 7.464 5.828 7.5 6.068 7.572C6.316 7.644 6.588 7.748 6.884 7.884L7.208 7.152C6.928 7.008 6.604 6.888 6.236 6.792C5.876 6.696 5.504 6.648 5.12 6.648C4.6 6.648 4.14 6.74 3.74 6.924C3.348 7.1 3.044 7.344 2.828 7.656C2.62 7.968 2.516 8.316 2.516 8.7C2.516 9.244 2.688 9.704 3.032 10.08C3.384 10.456 3.932 10.804 4.676 11.124C5.196 11.348 5.604 11.548 5.9 11.724C6.204 11.892 6.436 12.084 6.596 12.3C6.756 12.508 6.836 12.752 6.836 13.032C6.836 13.424 6.664 13.744 6.32 13.992C5.984 14.232 5.504 14.352 4.88 14.352C4.528 14.352 4.168 14.304 3.8 14.208C3.44 14.104 3.132 13.988 2.876 13.86L2.648 14.604ZM13.7443 12.24C13.7443 11.28 13.5403 10.504 13.1323 9.912C12.7323 9.32 12.1083 9.024 11.2603 9.024C10.7003 9.024 10.2123 9.156 9.79634 9.42C9.38834 9.676 9.07634 10.036 8.86034 10.5C8.65234 10.956 8.54834 11.48 8.54834 12.072C8.54834 13.008 8.80834 13.756 9.32834 14.316C9.84834 14.876 10.6043 15.156 11.5963 15.156C11.9963 15.156 12.3603 15.104 12.6883 15C13.0163 14.888 13.3443 14.74 13.6723 14.556L13.3723 13.86C13.0123 14.036 12.7003 14.164 12.4363 14.244C12.1803 14.324 11.8963 14.364 11.5843 14.364C10.8963 14.364 10.3843 14.176 10.0483 13.8C9.72034 13.416 9.54434 12.896 9.52034 12.24H13.7443ZM9.54434 11.592C9.60034 11.048 9.76834 10.62 10.0483 10.308C10.3363 9.988 10.7283 9.828 11.2243 9.828C12.1443 9.828 12.6723 10.416 12.8083 11.592H9.54434ZM15.3886 10.248C15.6766 10.12 15.9406 10.024 16.1806 9.96C16.4286 9.888 16.7246 9.852 17.0686 9.852C17.5086 9.852 17.8286 9.976 18.0286 10.224C18.2366 10.472 18.3406 10.812 18.3406 11.244V11.568H16.8406C16.2086 11.568 15.7006 11.724 15.3166 12.036C14.9326 12.348 14.7406 12.784 14.7406 13.344C14.7406 13.88 14.9086 14.316 15.2446 14.652C15.5886 14.988 16.0846 15.156 16.7326 15.156C17.0366 15.156 17.3486 15.084 17.6686 14.94C17.9886 14.788 18.2566 14.612 18.4726 14.412L18.5926 15H19.3006V10.98C19.3006 10.604 19.2046 10.268 19.0126 9.972C18.8206 9.676 18.5526 9.444 18.2086 9.276C17.8646 9.108 17.4726 9.024 17.0326 9.024C16.7686 9.024 16.4326 9.072 16.0246 9.168C15.6246 9.264 15.3206 9.384 15.1126 9.528L15.3886 10.248ZM15.6166 13.344C15.6166 13.024 15.7206 12.756 15.9286 12.54C16.1446 12.316 16.4406 12.204 16.8166 12.204H18.3526V13.524C18.1366 13.78 17.8846 13.988 17.5966 14.148C17.3166 14.308 17.0206 14.388 16.7086 14.388C16.3486 14.388 16.0766 14.284 15.8926 14.076C15.7086 13.868 15.6166 13.624 15.6166 13.344ZM21.704 10.992C21.976 10.712 22.308 10.468 22.7 10.26C23.092 10.044 23.448 9.936 23.768 9.936L23.54 9.18C23.26 9.18 22.936 9.28 22.568 9.48C22.2 9.68 21.884 9.892 21.62 10.116L21.32 9.18H20.756V15H21.704V10.992ZM28.7026 13.944C28.4226 14.088 28.1706 14.192 27.9466 14.256C27.7226 14.32 27.4346 14.352 27.0826 14.352C26.4986 14.352 26.0466 14.14 25.7266 13.716C25.4066 13.292 25.2466 12.74 25.2466 12.06C25.2546 11.412 25.4266 10.88 25.7626 10.464C26.0986 10.04 26.5546 9.828 27.1306 9.828C27.4666 9.828 27.7386 9.86 27.9466 9.924C28.1626 9.988 28.4306 10.088 28.7506 10.224L29.0386 9.552C28.8066 9.4 28.4986 9.276 28.1146 9.18C27.7386 9.076 27.4186 9.024 27.1546 9.024C26.5786 9.024 26.0746 9.156 25.6426 9.42C25.2106 9.676 24.8746 10.036 24.6346 10.5C24.4026 10.956 24.2866 11.48 24.2866 12.072C24.2866 12.672 24.3986 13.208 24.6226 13.68C24.8466 14.144 25.1706 14.508 25.5946 14.772C26.0186 15.028 26.5186 15.156 27.0946 15.156C27.3586 15.156 27.6826 15.104 28.0666 15C28.4506 14.904 28.7626 14.78 29.0026 14.628L28.7026 13.944ZM33.3227 9C33.9387 9 34.3947 9.188 34.6907 9.564C34.9947 9.932 35.1467 10.428 35.1467 11.052V14.988H34.1987V11.184C34.1987 10.752 34.1187 10.416 33.9587 10.176C33.7987 9.936 33.5307 9.816 33.1547 9.816C32.8667 9.816 32.5387 9.916 32.1707 10.116C31.8107 10.316 31.4907 10.568 31.2107 10.872V15H30.2627V6.648L31.2107 6.528V9.924C31.4907 9.652 31.8227 9.432 32.2067 9.264C32.5987 9.088 32.9707 9 33.3227 9ZM41.8363 9.024C42.7003 9.024 43.3763 9.308 43.8643 9.876C44.3603 10.436 44.6083 11.18 44.6083 12.108C44.6083 12.7 44.4923 13.228 44.2603 13.692C44.0363 14.148 43.7123 14.508 43.2883 14.772C42.8723 15.028 42.3803 15.156 41.8123 15.156C41.5723 15.156 41.3163 15.104 41.0443 15C40.7803 14.904 40.5323 14.764 40.3003 14.58L40.0963 15H39.5323V6.648L40.4803 6.528V9.468C40.6963 9.324 40.9243 9.216 41.1643 9.144C41.4043 9.064 41.6283 9.024 41.8363 9.024ZM41.8363 14.352C42.4123 14.352 42.8563 14.144 43.1683 13.728C43.4803 13.312 43.6403 12.776 43.6483 12.12C43.6483 11.432 43.4923 10.88 43.1803 10.464C42.8763 10.04 42.4323 9.828 41.8483 9.828C41.5603 9.828 41.3083 9.872 41.0923 9.96C40.8763 10.048 40.6723 10.184 40.4803 10.368V13.836C40.6723 14.004 40.8763 14.132 41.0923 14.22C41.3083 14.308 41.5563 14.352 41.8363 14.352ZM46.9278 15.96C46.8398 16.2 46.7038 16.38 46.5198 16.5C46.3438 16.628 46.0678 16.78 45.6918 16.956L45.9798 17.64C46.4038 17.552 46.7758 17.38 47.0958 17.124C47.4238 16.868 47.6558 16.56 47.7918 16.2L50.3598 9.18H49.3998L47.7318 13.68L45.9678 9L45.1278 9.36L47.2878 14.964L46.9278 15.96Z" fill="black"/>
                </g>
                <defs>
                  <clipPath id="clip0">
                    <rect width="141" height="21" fill="white"/>
                  </clipPath>
                </defs>
              </svg>
            </a>
          </div>
        </div>

        {searchResultState.items.length > 0 ? (
          <main>
            {searchResultState.items.map(
              ({title, url, summary, breadcrumbs}, i) => (
                <article key={i} className={styles.searchResultItem}>
                  <h2 className={styles.searchResultItemHeading}>
                    <Link to={url} dangerouslySetInnerHTML={{__html: title}} />
                  </h2>

                  {breadcrumbs.length > 0 && (
                    <nav aria-label="breadcrumbs">
                      <ul
                        className={clsx(
                          'breadcrumbs',
                          styles.searchResultItemPath,
                        )}>
                        {breadcrumbs.map((html, index) => (
                          <li
                            key={index}
                            className="breadcrumbs__item"
                            // Developer provided the HTML, so assume it's safe.
                            // eslint-disable-next-line react/no-danger
                            dangerouslySetInnerHTML={{__html: html}}
                          />
                        ))}
                      </ul>
                    </nav>
                  )}

                  {summary && (
                    <p
                      className={styles.searchResultItemSummary}
                      // Developer provided the HTML, so assume it's safe.
                      // eslint-disable-next-line react/no-danger
                      dangerouslySetInnerHTML={{__html: summary}}
                    />
                  )}
                </article>
              ),
            )}
          </main>
        ) : (
          [
            searchQuery && !searchResultState.loading && (
              <p key="no-results">
                <Translate
                  id="theme.SearchPage.noResultsText"
                  description="The paragraph for empty search result">
                  No results were found
                </Translate>
              </p>
            ),
            !!searchResultState.loading && (
              <div key="spinner" className={styles.loadingSpinner} />
            ),
          ]
        )}

        {searchResultState.hasMore && (
          <div className={styles.loader} ref={setLoaderRef}>
            <Translate
              id="theme.SearchPage.fetchingNewResults"
              description="The paragraph for fetching new search results">
              Fetching new results...
            </Translate>
          </div>
        )}
      </div>
    </Layout>
  );
}

export default SearchPage;
