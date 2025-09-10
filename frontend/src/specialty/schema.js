// src/specialty/schema.js
// Guideline-aligned compact schemas (2024–2025 era).
// ACC/AHA chest pain, GINA 2024 (asthma), GOLD 2024 (COPD),
// ADA 2025 (diabetes), KDIGO 2024 (CKD), NICE NG84 (sore throat),
// WHO ANC, AAP pediatric acute visit.
// src/specialty/schema.js
// Central place for all specialty form definitions.
// Each specialty gets practical, clinic-ready fields (no S/O/A buckets).
// We still segment into steps for UX (Visit & Demographics, History & Risk,
// Exam & Vitals, Tests & Provisional Plan), but content is specialty-specific.

export const FIELD_TYPES = {
  TEXT: "text",
  TEXTAREA: "textarea",
  NUMBER: "number",
  DATE: "date",
  SELECT: "select",
  RADIO: "radio",
  MULTISELECT: "multiselect",
  TOGGLE: "toggle",
};

// Human readable labels for pills/headings
export const SPECIALTY_LABELS = {
  pediatrics: "Pediatrics",
  obgyn: "Obstetrics & Gynecology",
  cardiology: "Cardiology",
  orthopedics: "Orthopedics",
  dermatology: "Dermatology",
  neurology: "Neurology",
  ent: "ENT",
  ophthalmology: "Ophthalmology",
  nephrology: "Nephrology",
  pulmonology: "Pulmonology",
  family: "Family Medicine",
};

// ---------- COMMON OPTIONS ----------
const YES_NO = ["Yes", "No"];
const SEX = ["Male", "Female"];
const SEVERITY = ["Mild", "Moderate", "Severe"];
const PAIN_SCALE = ["0","1","2","3","4","5","6","7","8","9","10"];
const FEVER_PATTERN = ["None","Low-grade","High (>39°C)","Intermittent","Persistent"];
const ROUTE = ["Oral","IV","IM","Nebulized","Topical"];
const VACC_STATUS = ["Up-to-date","Incomplete","Unknown"];
const FEEDING = ["Breast","Formula","Mixed","Solid age-appropriate"];
const DEVELOPMENT = ["Gross motor delay","Fine motor delay","Speech delay","Social delay","Age-appropriate"];
const YES_NO_NA = ["Yes","No","N/A"];

// ---------- SCHEMAS ----------

// Pediatrics (acute care / general OPD)
const SCHEMA_PEDIATRICS = {
  title: "Pediatrics Visit",
  steps: [
    {
      id: "peds-visit-demo",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true, placeholder: "Fever, cough, poor feeding…" },
        { id: "age_months", label: "Age (months)", type: FIELD_TYPES.NUMBER, required: true, unit: "months" },
        { id: "sex", label: "Sex", type: FIELD_TYPES.SELECT, options: SEX, required: true },
        { id: "weight", label: "Weight", type: FIELD_TYPES.NUMBER, unit: "kg", required: true },
        { id: "height", label: "Height/Length", type: FIELD_TYPES.NUMBER, unit: "cm" },
        { id: "temp", label: "Temperature", type: FIELD_TYPES.NUMBER, unit: "°C" },
        { id: "rr", label: "Respiratory Rate", type: FIELD_TYPES.NUMBER, unit: "breaths/min" },
        { id: "hr", label: "Heart Rate", type: FIELD_TYPES.NUMBER, unit: "beats/min" },
        { id: "spo2", label: "SpO₂", type: FIELD_TYPES.NUMBER, unit: "%" },
      ],
    },
    {
      id: "peds-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "History of Present Illness", type: FIELD_TYPES.TEXTAREA, required: true, placeholder: "Onset, duration, course, associated symptoms…" },
        { id: "fever_pattern", label: "Fever Pattern", type: FIELD_TYPES.SELECT, options: FEVER_PATTERN },
        { id: "feeding", label: "Feeding", type: FIELD_TYPES.SELECT, options: FEEDING },
        { id: "hydration", label: "Hydration Signs", type: FIELD_TYPES.MULTISELECT, options: ["Normal tears","Dry mucosa","Sunken eyes","Decreased urine","Lethargy"] },
        { id: "diapers_24h", label: "Wet Diapers (last 24h)", type: FIELD_TYPES.NUMBER },
        { id: "immunization", label: "Immunization Status", type: FIELD_TYPES.SELECT, options: VACC_STATUS },
        { id: "daycare", label: "Attends Daycare", type: FIELD_TYPES.RADIO, options: YES_NO },
        { id: "sick_contacts", label: "Sick Contacts", type: FIELD_TYPES.RADIO, options: YES_NO },
        { id: "dev", label: "Developmental Milestones", type: FIELD_TYPES.MULTISELECT, options: DEVELOPMENT },
        { id: "allergies", label: "Allergies", type: FIELD_TYPES.TEXTAREA, placeholder: "Drug/food allergies and reactions" },
        { id: "pmh", label: "Past Medical History", type: FIELD_TYPES.TEXTAREA, placeholder: "Asthma, prematurity, congenital issues…" },
        { id: "meds", label: "Current Medications", type: FIELD_TYPES.TEXTAREA, placeholder: "Dose, frequency, last dose taken…" },
        { id: "red_flags", label: "Red Flags", type: FIELD_TYPES.MULTISELECT, options: ["Poor perfusion","Lethargy","Grunting","Chest indrawing","Apnea","Convulsion"] },
      ],
    },
    {
      id: "peds-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "gen_appearance", label: "General Appearance", type: FIELD_TYPES.SELECT, options: ["Alert","Irritable","Lethargic","Toxic-appearing"] },
        { id: "work_of_breathing", label: "Work of Breathing", type: FIELD_TYPES.SELECT, options: ["Normal","Mild ↑","Moderate ↑","Severe ↑"] },
        { id: "wheeze", label: "Wheeze", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "crackle", label: "Crackles", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "ear_findings", label: "Ear/Throat Findings", type: FIELD_TYPES.MULTISELECT, options: ["AOM signs","Pharyngitis","Tonsillar exudates","None"] },
        { id: "skin_findings", label: "Skin Findings", type: FIELD_TYPES.MULTISELECT, options: ["Rash","Mottling","Petechiae","None"] },
      ],
    },
    {
      id: "peds-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "labs", label: "Labs to Consider", type: FIELD_TYPES.MULTISELECT, options: ["CBC","CRP/ESR","Blood culture","Urinalysis","RSV/Flu test","COVID antigen/PCR"] },
        { id: "imaging", label: "Imaging", type: FIELD_TYPES.MULTISELECT, options: ["Chest X-ray","Neck X-ray","None"] },
        { id: "severity", label: "Severity", type: FIELD_TYPES.RADIO, options: SEVERITY },
        { id: "home_care", label: "Home Care Education Given", type: FIELD_TYPES.TOGGLE },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA, placeholder: "Any additional considerations…" },
      ],
    },
  ],
};

// OBGYN (general clinic / early pregnancy)
const SCHEMA_OBGYN = {
  title: "Obstetrics & Gynecology Visit",
  steps: [
    {
      id: "obgyn-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years", required: true },
        { id: "lmp", label: "Last Menstrual Period (LMP)", type: FIELD_TYPES.DATE },
        { id: "pregnant", label: "Pregnant", type: FIELD_TYPES.RADIO, options: YES_NO },
        { id: "g_p", label: "Gravida / Para", type: FIELD_TYPES.TEXT, placeholder: "e.g., G3P1" },
        { id: "ga_weeks", label: "Gestational Age (if pregnant)", type: FIELD_TYPES.NUMBER, unit: "weeks" },
      ],
    },
    {
      id: "obgyn-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "History of Present Illness", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "bleeding", label: "Vaginal Bleeding", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "pain", label: "Pelvic/Abdominal Pain", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "discharge", label: "Abnormal Discharge", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "sti_history", label: "STI History", type: FIELD_TYPES.MULTISELECT, options: ["Chlamydia","Gonorrhea","HSV","Syphilis","HPV","None"] },
        { id: "contraception", label: "Contraception", type: FIELD_TYPES.SELECT, options: ["None","OCP","IUD","Implant","Barrier"] },
        { id: "ob_history", label: "OB History", type: FIELD_TYPES.TEXTAREA, placeholder: "Miscarriages, ectopic, C-section, complications…" },
        { id: "gyne_history", label: "GYNE History", type: FIELD_TYPES.TEXTAREA, placeholder: "Fibroids, PCOS, endometriosis, surgeries…" },
        { id: "allergies", label: "Allergies", type: FIELD_TYPES.TEXTAREA },
        { id: "meds", label: "Current Medications", type: FIELD_TYPES.TEXTAREA },
      ],
    },
    {
      id: "obgyn-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "bp", label: "Blood Pressure", type: FIELD_TYPES.TEXT, placeholder: "e.g., 110/70" },
        { id: "hr", label: "Heart Rate", type: FIELD_TYPES.NUMBER, unit: "bpm" },
        { id: "temp", label: "Temperature", type: FIELD_TYPES.NUMBER, unit: "°C" },
        { id: "abd_tender", label: "Abdominal Tenderness", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "speculum_exam", label: "Speculum Exam Needed", type: FIELD_TYPES.TOGGLE },
        { id: "preg_test", label: "Urine β-hCG", type: FIELD_TYPES.SELECT, options: ["Not done","Negative","Positive"] },
      ],
    },
    {
      id: "obgyn-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "labs", label: "Labs", type: FIELD_TYPES.MULTISELECT, options: ["CBC","β-hCG (quant)","Rh type & screen","Urinalysis","STI panel"] },
        { id: "imaging", label: "Imaging", type: FIELD_TYPES.MULTISELECT, options: ["Pelvic US","Transvaginal US","None"] },
        { id: "treatment_route", label: "Preferred Treatment Route", type: FIELD_TYPES.SELECT, options: ROUTE },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Cardiology (chest pain / dyspnea clinic)
const SCHEMA_CARDIOLOGY = {
  title: "Cardiology Visit",
  steps: [
    {
      id: "cardio-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years", required: true },
        { id: "sex", label: "Sex", type: FIELD_TYPES.SELECT, options: SEX, required: true },
        { id: "bp", label: "Blood Pressure", type: FIELD_TYPES.TEXT, placeholder: "e.g., 140/90" },
        { id: "hr", label: "Heart Rate", type: FIELD_TYPES.NUMBER, unit: "bpm" },
        { id: "spo2", label: "SpO₂", type: FIELD_TYPES.NUMBER, unit: "%" },
      ],
    },
    {
      id: "cardio-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "History of Present Illness", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "pain_type", label: "Chest Pain Character", type: FIELD_TYPES.SELECT, options: ["Typical angina","Atypical chest pain","Non-cardiac","No pain"] },
        { id: "pain_duration", label: "Pain Duration", type: FIELD_TYPES.SELECT, options: ["<10 min","10–30 min",">30 min","Constant"] },
        { id: "exertional", label: "Exertional Symptoms", type: FIELD_TYPES.RADIO, options: YES_NO },
        { id: "risk_factors", label: "Risk Factors", type: FIELD_TYPES.MULTISELECT, options: ["HTN","DM","Dyslipidemia","Smoking","FHx CAD","Obesity"] },
        { id: "pmh", label: "Cardiac PMH", type: FIELD_TYPES.TEXTAREA, placeholder: "MI, PCI/CABG, HF, arrhythmias…" },
        { id: "meds", label: "Current Cardiac Meds", type: FIELD_TYPES.TEXTAREA, placeholder: "Antiplatelets, statins, beta-blockers…" },
        { id: "allergies", label: "Allergies", type: FIELD_TYPES.TEXTAREA },
      ],
    },
    {
      id: "cardio-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "jvp", label: "JVP Elevated", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "edema", label: "Peripheral Edema", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "murmur", label: "Murmur", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "rales", label: "Lung Rales", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "ecg_done", label: "ECG Done", type: FIELD_TYPES.TOGGLE },
      ],
    },
    {
      id: "cardio-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "labs", label: "Labs", type: FIELD_TYPES.MULTISELECT, options: ["Troponin","BNP/NT-proBNP","Lipid panel","HbA1c","CMP"] },
        { id: "imaging", label: "Imaging/Tests", type: FIELD_TYPES.MULTISELECT, options: ["CXR","Echocardiogram","Stress test","CTCA"] },
        { id: "severity", label: "Clinical Severity", type: FIELD_TYPES.RADIO, options: SEVERITY },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Orthopedics (injury / pain)
const SCHEMA_ORTHO = {
  title: "Orthopedics Visit",
  steps: [
    {
      id: "ortho-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years", required: true },
        { id: "side", label: "Side", type: FIELD_TYPES.SELECT, options: ["Right","Left","Bilateral","Midline"] },
        { id: "mechanism", label: "Mechanism of Injury", type: FIELD_TYPES.SELECT, options: ["Fall","Twist","Crush","Road traffic","Sports","Overuse","Unknown"] },
        { id: "pain_scale", label: "Pain Scale (0–10)", type: FIELD_TYPES.SELECT, options: PAIN_SCALE },
      ],
    },
    {
      id: "ortho-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "History of Present Illness", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "weight_bearing", label: "Weight Bearing Possible", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "red_flags", label: "Red Flags", type: FIELD_TYPES.MULTISELECT, options: ["Open wound","Deformity","Neuro deficit","Severe swelling","Fever"] },
        { id: "pmh", label: "Relevant PMH", type: FIELD_TYPES.TEXTAREA, placeholder: "Osteoporosis, previous fractures…" },
        { id: "allergies", label: "Allergies", type: FIELD_TYPES.TEXTAREA },
      ],
    },
    {
      id: "ortho-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "inspection", label: "Inspection", type: FIELD_TYPES.MULTISELECT, options: ["Swelling","Ecchymosis","Deformity","Open wound","Normal"] },
        { id: "palpation", label: "Palpation Tenderness", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
        { id: "rom", label: "Range of Motion", type: FIELD_TYPES.SELECT, options: ["Full","Reduced","Severely limited"] },
        { id: "neurovascular", label: "Neurovascular Status Intact", type: FIELD_TYPES.RADIO, options: YES_NO_NA },
      ],
    },
    {
      id: "ortho-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "imaging", label: "Imaging", type: FIELD_TYPES.MULTISELECT, options: ["X-ray","CT","MRI","Ultrasound","None"] },
        { id: "labs", label: "Labs (if indicated)", type: FIELD_TYPES.MULTISELECT, options: ["CBC","CRP/ESR","Uric acid","None"] },
        { id: "immobilize", label: "Immobilization Needed", type: FIELD_TYPES.TOGGLE },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Dermatology (rash / lesion)
const SCHEMA_DERM = {
  title: "Dermatology Visit",
  steps: [
    {
      id: "derm-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years", required: true },
        { id: "duration", label: "Duration", type: FIELD_TYPES.SELECT, options: ["<1 week","1–4 weeks","1–3 months",">3 months"] },
      ],
    },
    {
      id: "derm-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "History of Present Illness", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "pruritus", label: "Pruritus (itching)", type: FIELD_TYPES.RADIO, options: YES_NO },
        { id: "triggers", label: "Triggers", type: FIELD_TYPES.MULTISELECT, options: ["Heat","Sweat","Sun","Food","Detergent","Stress","Unknown"] },
        { id: "allergies", label: "Allergies/Atopy", type: FIELD_TYPES.TEXTAREA },
        { id: "meds", label: "Current/Recent Topicals/Systemics", type: FIELD_TYPES.TEXTAREA },
      ],
    },
    {
      id: "derm-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "distribution", label: "Distribution", type: FIELD_TYPES.MULTISELECT, options: ["Face","Trunk","Extensors","Flexors","Palms/Soles","Scalp","Generalized"] },
        { id: "morphology", label: "Morphology", type: FIELD_TYPES.MULTISELECT, options: ["Macules","Papules","Plaques","Vesicles","Pustules","Nodules","Scales","Crusts"] },
        { id: "secondary", label: "Secondary Changes", type: FIELD_TYPES.MULTISELECT, options: ["Excoriations","Lichenification","Fissures","Ulceration","None"] },
        { id: "koh", label: "KOH Test Performed", type: FIELD_TYPES.TOGGLE },
        { id: "dermoscopy", label: "Dermoscopy Performed", type: FIELD_TYPES.TOGGLE },
      ],
    },
    {
      id: "derm-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "labs", label: "Labs (if needed)", type: FIELD_TYPES.MULTISELECT, options: ["CBC","IgE","CRP/ESR","Bacterial culture","Fungal culture","Patch test"] },
        { id: "biopsy", label: "Biopsy Considered", type: FIELD_TYPES.TOGGLE },
        { id: "route", label: "Treatment Route", type: FIELD_TYPES.SELECT, options: ["Topical","Systemic","Phototherapy"] },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Neurology (headache / seizure general)
const SCHEMA_NEURO = {
  title: "Neurology Visit",
  steps: [
    {
      id: "neuro-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years", required: true },
        { id: "onset", label: "Onset", type: FIELD_TYPES.SELECT, options: ["Acute","Subacute","Chronic","Recurrent"] },
      ],
    },
    {
      id: "neuro-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "History of Present Illness", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "neuro_red_flags", label: "Red Flags", type: FIELD_TYPES.MULTISELECT, options: ["Sudden severe headache","Focal deficit","Fever/neck stiffness","Trauma","Immunosuppression"] },
        { id: "pmh", label: "Neurologic PMH", type: FIELD_TYPES.TEXTAREA },
        { id: "allergies", label: "Allergies", type: FIELD_TYPES.TEXTAREA },
        { id: "meds", label: "Current Medications", type: FIELD_TYPES.TEXTAREA },
      ],
    },
    {
      id: "neuro-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "neuro_exam", label: "Neuro Exam Highlights", type: FIELD_TYPES.MULTISELECT, options: ["Normal","Cranial nerve deficit","Motor weakness","Sensory deficit","Ataxia","Aphasia"] },
        { id: "bp", label: "Blood Pressure", type: FIELD_TYPES.TEXT },
        { id: "temp", label: "Temperature", type: FIELD_TYPES.NUMBER, unit: "°C" },
      ],
    },
    {
      id: "neuro-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "imaging", label: "Imaging", type: FIELD_TYPES.MULTISELECT, options: ["CT head","MRI brain","MRA/CTA","None"] },
        { id: "labs", label: "Labs", type: FIELD_TYPES.MULTISELECT, options: ["CBC","CMP","CRP/ESR","TSH","B12"] },
        { id: "lp", label: "Lumbar Puncture Considered", type: FIELD_TYPES.TOGGLE },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// ENT (common)
const SCHEMA_ENT = {
  title: "ENT Visit",
  steps: [
    {
      id: "ent-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true },
        { id: "age", label: "Age", type: FIELD_TYPES.NUMBER, unit: "years" },
      ],
    },
    {
      id: "ent-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "History of Present Illness", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "ear_symptoms", label: "Ear Symptoms", type: FIELD_TYPES.MULTISELECT, options: ["Otalgia","Otorrhea","Hearing loss","Tinnitus","Vertigo"] },
        { id: "nose_symptoms", label: "Nasal Symptoms", type: FIELD_TYPES.MULTISELECT, options: ["Congestion","Rhinorrhea","Epistaxis","Anosmia"] },
        { id: "throat_symptoms", label: "Throat Symptoms", type: FIELD_TYPES.MULTISELECT, options: ["Sore throat","Hoarseness","Dysphagia","Odynophagia"] },
        { id: "allergies", label: "Allergies", type: FIELD_TYPES.TEXTAREA },
        { id: "meds", label: "Current Medications", type: FIELD_TYPES.TEXTAREA },
      ],
    },
    {
      id: "ent-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "otoscopy", label: "Otoscopy", type: FIELD_TYPES.SELECT, options: ["Normal","AOM signs","OME","TM perforation"] },
        { id: "nasal_exam", label: "Nasal Exam", type: FIELD_TYPES.SELECT, options: ["Normal","Polyps","Deviated septum","Inflamed turbinates"] },
        { id: "throat_exam", label: "Throat Exam", type: FIELD_TYPES.SELECT, options: ["Normal","Erythema","Exudates","Tonsillar hypertrophy"] },
      ],
    },
    {
      id: "ent-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "labs", label: "Labs", type: FIELD_TYPES.MULTISELECT, options: ["Throat swab","CBC","Allergy panel","None"] },
        { id: "imaging", label: "Imaging", type: FIELD_TYPES.MULTISELECT, options: ["Sinus CT","Neck US","None"] },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// Ophthalmology (concise OPD)
const SCHEMA_OPHTH = {
  title: "Ophthalmology Visit",
  steps: [
    {
      id: "eye-visit",
      title: "Visit & Demographics",
      fields: [
        { id: "cc", label: "Chief Complaint", type: FIELD_TYPES.TEXT, required: true },
        { id: "eye", label: "Eye", type: FIELD_TYPES.SELECT, options: ["Right","Left","Both"] },
        { id: "duration", label: "Duration", type: FIELD_TYPES.SELECT, options: ["<24h","1–7 days","1–4 weeks",">1 month"] },
      ],
    },
    {
      id: "eye-history",
      title: "History & Risk",
      fields: [
        { id: "hpi", label: "History of Present Illness", type: FIELD_TYPES.TEXTAREA, required: true },
        { id: "symptoms", label: "Symptoms", type: FIELD_TYPES.MULTISELECT, options: ["Redness","Pain","Photophobia","Discharge","Blurred vision","Floaters"] },
        { id: "contacts", label: "Contact Lens Use", type: FIELD_TYPES.RADIO, options: YES_NO },
        { id: "trauma", label: "Recent Trauma", type: FIELD_TYPES.RADIO, options: YES_NO },
        { id: "allergies", label: "Allergies", type: FIELD_TYPES.TEXTAREA },
      ],
    },
    {
      id: "eye-exam",
      title: "Exam & Vitals",
      fields: [
        { id: "visual_acuity", label: "Visual Acuity (if known)", type: FIELD_TYPES.TEXT, placeholder: "e.g., 6/9, 20/40" },
        { id: "fluorescein", label: "Fluorescein Stain Performed", type: FIELD_TYPES.TOGGLE },
        { id: "iop", label: "IOP Checked", type: FIELD_TYPES.TOGGLE },
      ],
    },
    {
      id: "eye-tests-plan",
      title: "Tests & Provisional Plan",
      fields: [
        { id: "labs", label: "Labs (if needed)", type: FIELD_TYPES.MULTISELECT, options: ["Culture swab","HSV PCR","None"] },
        { id: "imaging", label: "Imaging", type: FIELD_TYPES.MULTISELECT, options: ["B-scan US","OCT","None"] },
        { id: "notes", label: "Clinician Notes", type: FIELD_TYPES.TEXTAREA },
      ],
    },
  ],
};

// (You can add more specialties following the same structure.)

export const SPECIALTY_SCHEMAS = {
  pediatrics: SCHEMA_PEDIATRICS,
  obgyn: SCHEMA_OBGYN,
  cardiology: SCHEMA_CARDIOLOGY,
  orthopedics: SCHEMA_ORTHO,
  dermatology: SCHEMA_DERM,
  neurology: SCHEMA_NEURO,
  ent: SCHEMA_ENT,
  ophthalmology: SCHEMA_OPHTH,
};

export const DEFAULT_SCHEMA = SCHEMA_PEDIATRICS;
